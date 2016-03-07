import path = require('path');
import Winston = require('winston');
import TypeState = require('../../SimulationService/state/typestate');
import csweb = require('csweb');
import SimSvc = require('../../SimulationService/api/SimServiceManager');
import HyperTimer = require('hypertimer');


/** Defines the types of simulationservices available in a scenario */
export interface ISimScenario {
    sims: {
        folder: string,
        type: string
    }[];
}

/**
 * The simulation manager is responsible for:
 * - managing the simulation time, speed and state.
 * - viewing the state of the simulation (who is online, what is their simulation status).
 * - storing the world state.
 */
export class SimulationManager extends SimSvc.SimServiceManager {
    /** The topic/key that is used for publishing simulation time messages */
    private simTimeKey: string;
    /**
     * Timer to send the time messages to all sims.
     * @type {HyperTimer}
     */
    private timer: HyperTimer;
    /**
     * Dictionary of active sims.
     * @type {SimSvc.ISimState[]}
     */
    private sims: { [id: string]: SimSvc.ISimState } = {};
    /**
     * Contains the id of all sims that are not ready, so they cannot receive time events.
     * @type {number}
     */
    private simsNotReady: string[] = [];
    private simServices: { [ key:string ]: any };
    /** Dictionary with available scenarios */
    public availableScenarios: { [key: string]: ISimScenario };
    public currentScenario: string;

    constructor(namespace: string, name: string, public isClient = false, simServices: any, options = <csweb.IApiManagerOptions>{}) {
        super(namespace, name, isClient, options);
        this.availableScenarios = {};
        if (options) {
            if (options.hasOwnProperty('simDataFolder')) {
                this.simDataFolder = options['simDataFolder'];
                this.scanScenarioFolders();
            }
        }
        this.simServices = simServices;
        this.simTimeKey = `${SimSvc.SimServiceManager.namespace}.${SimSvc.Keys[SimSvc.Keys.SimTime]}`;
    }

    private reset() {
        this.sims = {};
        this.simsNotReady = [];

        this.deleteFilesInFolder(path.join(__dirname, '../public/data/layers'));
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/keys'));

        this.sendAck(this.fsm.currentState);
    }


    private scanScenarioFolders() {
        var count = 0;
        var scenariosFolder = path.join(__dirname, '../../', this.simDataFolder, 'Scenarios');
        var scenarios = csweb.getDirectories(scenariosFolder);
        scenarios.forEach(scName => {
            var scenario: ISimScenario = <ISimScenario>{sims: []};
            var scenarioFolder = path.join(scenariosFolder, scName);
            var types = csweb.getDirectories(scenarioFolder);
            types.forEach(type => {
                var sim = {type: type, folder: path.join(scenarioFolder, type)};
                scenario.sims.push(sim);
            });
            this.availableScenarios[scName.toLowerCase()] = scenario;
            count++;
        });
        Winston.info('Scanned ' + count + ' scenario folders');
    }

    private startScenario(scenarioName: string) {
        if (this.currentScenario === scenarioName) {
            Winston.info('Scenario ' + scenarioName + ' already loaded');
            return;
        }
        if (Object.keys(this.availableScenarios).indexOf(scenarioName) < 0) {
            Winston.warn('Scenario ' + scenarioName + ' not found');
            return;
        }
        var scenario = this.availableScenarios[scenarioName];
        scenario.sims.forEach((sim) => {
            if (!this.simServices.hasOwnProperty(sim.type)) {
                Winston.warn('SimService ' + sim.type + ' not found.');
                return;
            }
            this.simServices[sim.type].start(path.join(sim.folder));
            Winston.info('Started ' + sim.type +  ' with folder: ' + sim.folder);
        });
        this.currentScenario = scenarioName;
         Winston.info('Scenario ' + scenarioName + ' loaded succesfully');
    }


    private initFsm() {
        // When ready, start sending messages.
        this.fsm.onEnter(SimSvc.SimState.Ready, (toState) => {
            Winston.warn('Starting...');
            this.startTimer();
            this.sendAck(toState);
            return true;
        });

        // When moving to pause or idle, pause the timer.
        this.fsm.onExit(SimSvc.SimState.Ready, (toState) => {
            Winston.warn('Pausing...');
            this.timer.pause();
            this.sendAck(toState);
            return true;
        });

        this.fsm.onEnter(SimSvc.SimState.Idle, (from) => {
            this.message = 'Reset received.'
            this.reset();
            return true;
        });

        this.on('simSpeedChanged', () => this.startTimer());

        // Listen to JOBS
        this.subscribeKey(`${SimSvc.SimServiceManager.namespace}.${SimSvc.Keys[SimSvc.Keys.Job]}`, <csweb.ApiMeta>{}, (topic: string, message: any, meta?: csweb.ApiMeta) => {
            Winston.info('Received job: ', message);
            if (message.hasOwnProperty('get')) {
                switch (message['get'].toLowerCase()) {
                    case 'scenarios':
                        this.updateKey(`${SimSvc.SimServiceManager.namespace}.${SimSvc.Keys[SimSvc.Keys.Job]}`, Object.keys(this.availableScenarios), <csweb.ApiMeta>{}, () => {});
                        break;
                    default:
                        Winston.info('Command ' + message['get'] + 'not found.');
                        break;
                }
            }
            if (message.hasOwnProperty('start')) {
                if (message['start'].length > 0) {
                    this.startScenario(message['start'].toLowerCase());
                }
            }
        });

        // Listen to Sim.SimState keys
        this.subscribeKey(`${SimSvc.SimServiceManager.namespace}.${SimSvc.Keys[SimSvc.Keys.SimState]}`, <csweb.ApiMeta>{}, (topic: string, message: string, params: Object) => {
            if (message === null) return;
            try {
                var simState: SimSvc.ISimState = (typeof message === 'object') ? message : JSON.parse(message);
                // Winston.info("Received sim state: ", simState);
                if (!simState || simState.id === this.id) return;
                var state = SimSvc.SimState[simState.state];
                var index = this.simsNotReady.indexOf(simState.id);
                if (state !== SimSvc.SimState.Ready) {
                    if (index < 0) this.simsNotReady.push(simState.id);
                } else {
                    if (index >= 0) this.simsNotReady.splice(index, 1);
                }
                this.sims[simState.id] = simState;
                // Read the upcoming event time of the sim, and check whether it is the first upcoming event of all sims
                if (simState.hasOwnProperty('nextEvent') && simState.nextEvent && state === SimSvc.SimState.Ready) {
                    if (!this.nextEvent || simState.nextEvent < this.nextEvent) {
                        this.nextEvent = simState.nextEvent;
                        Winston.info(`SimManager: Next event is ${(new Date(this.nextEvent)).toLocaleString() }.`);
                    }
                }
                // Listen to sims that move to Exit (when they have exited, we always try to emit a final Exit message).
                if (state === SimSvc.SimState.Exit) {
                    delete this.sims[simState.id];
                    if (index >= 0) this.simsNotReady.splice(index, 1);
                }
            } catch (e) { }
        });

        // Listen to NextEvent
        this.subscribeKey(`${SimSvc.SimServiceManager.namespace}.${SimSvc.Keys[SimSvc.Keys.NextEvent]}`, <csweb.ApiMeta>{}, (topic: string, message: string, params: Object) => {
            if (message === null) return;
            try {
                var msgObject = (typeof message === 'object') ? message : JSON.parse(message);
                if (!msgObject || !msgObject.next || !this.nextEvent) return;
                if (this.continue()) {
                    this.timer.config({ time: (new Date(this.nextEvent)).toISOString() });
                    this.nextEvent = null;
                    this.publishTime();
                    Winston.info(`Forwarded to time: ${this.timer.getTime().toLocaleString() }`);
                } else {
                    Winston.warn(`Simulation is not ready to continue yet`);
                }
            } catch (e) { }
        });
    }

    /**
     * Override the start method to specify your own startup behaviour.
     * Although you could use the init method, at that time the connectors haven't been configured yet.
     */
    public start() {
        super.start();

        this.reset();
        this.initFsm();
    }

    /**
     * Create a new timer and start it.
     * As the start time may have changed, the speed or interval (time step), create a new timer.
     * @method startTimer
     * @return {void}
     */
    private startTimer() {
        if (this.timer) this.timer.clear();
        this.timer = new HyperTimer({
            time: this.simTime,
            rate: this.simSpeed || 1,
            paced: true
        });
        this.timer.setInterval(() => {
            this.simTime = this.timer.getTime();
            if (this.continue()) this.publishTime();
        }, this.simTimeStep * this.simSpeed); // Default every 5 seconds
    }

    /**
     * Check whether we should continue or pause the simulation based on the current conditions.
     * @method continue
     * @return {boolean}        [Returns true if we can continue, false otherwise]
     */
    private continue() {
        if (this.simsNotReady.length === 0) {
            // All sims are ready, so if we are not running, and should be running, continue.
            if (!this.timer.running && this.fsm.currentState === SimSvc.SimState.Ready) {
                this.publishTime(); // Inform others
                this.timer.continue();
            }
            return true;
        }
        // Some sims are not ready, so if we are running, pause.
        if (this.timer.running) this.timer.pause();
        return false;
    }

    /**
     * Publish a time message.
     * @method publishTime
     * @return {void}
     */
    private publishTime() {
        this.updateKey(this.simTimeKey, this.timer.getTime().valueOf(), <csweb.ApiMeta>{}, () => { });
    }
}

var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var path = require('path');
var Winston = require('winston');
var SimSvc = require('../../SimulationService/api/SimServiceManager');
var HyperTimer = require('hypertimer');
var Utils = require('../../ServerComponents/helpers/Utils');
/**
 * The simulation manager is responsible for:
 * - managing the simulation time, speed and state.
 * - viewing the state of the simulation (who is online, what is their simulation status).
 * - storing the world state.
 */
var SimulationManager = (function (_super) {
    __extends(SimulationManager, _super);
    function SimulationManager(namespace, name, isClient, simServices, options) {
        if (isClient === void 0) { isClient = false; }
        if (options === void 0) { options = {}; }
        _super.call(this, namespace, name, isClient, options);
        this.isClient = isClient;
        /**
         * Dictionary of active sims.
         * @type {SimSvc.ISimState[]}
         */
        this.sims = {};
        /**
         * Contains the id of all sims that are not ready, so they cannot receive time events.
         * @type {number}
         */
        this.simsNotReady = [];
        this.availableScenarios = {};
        if (options) {
            if (options.hasOwnProperty('simDataFolder')) {
                this.simDataFolder = options['simDataFolder'];
                this.scanScenarioFolders();
            }
        }
        this.simServices = simServices;
        this.simTimeKey = SimSvc.SimServiceManager.namespace + "." + SimSvc.Keys[SimSvc.Keys.SimTime];
    }
    SimulationManager.prototype.reset = function () {
        this.sims = {};
        this.simsNotReady = [];
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/layers'));
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/keys'));
        this.sendAck(this.fsm.currentState);
    };
    SimulationManager.prototype.scanScenarioFolders = function () {
        var _this = this;
        var count = 0;
        var scenariosFolder = path.join(this.simDataFolder, 'Scenarios');
        var scenarios = Utils.getDirectories(scenariosFolder);
        scenarios.forEach(function (scName) {
            var scenario = { sims: [] };
            var scenarioFolder = path.join(scenariosFolder, scName);
            var types = Utils.getDirectories(scenarioFolder);
            types.forEach(function (type) {
                var sim = { type: type, folder: path.join(scenarioFolder, type) };
                scenario.sims.push(sim);
            });
            _this.availableScenarios[scName.toLowerCase()] = scenario;
            count++;
        });
        Winston.info('Scanned ' + count + ' scenario folders');
    };
    SimulationManager.prototype.startScenario = function (scenarioName) {
        var _this = this;
        if (this.currentScenario === scenarioName) {
            Winston.info('Scenario ' + scenarioName + ' already loaded');
            return;
        }
        if (Object.keys(this.availableScenarios).indexOf(scenarioName) < 0) {
            Winston.warn('Scenario ' + scenarioName + ' not found');
            return;
        }
        var scenario = this.availableScenarios[scenarioName];
        scenario.sims.forEach(function (sim) {
            if (!_this.simServices.hasOwnProperty(sim.type)) {
                Winston.warn('SimService ' + sim.type + ' not found.');
                return;
            }
            _this.simServices[sim.type].start(path.join(__dirname, '../../', sim.folder));
            Winston.info('Started ' + sim.type + ' with folder: ' + sim.folder);
        });
        this.currentScenario = scenarioName;
        Winston.info('Scenario ' + scenarioName + ' loaded succesfully');
    };
    SimulationManager.prototype.initFsm = function () {
        var _this = this;
        // When ready, start sending messages.
        this.fsm.onEnter(SimSvc.SimState.Ready, function (toState) {
            Winston.warn('Starting...');
            _this.startTimer();
            _this.sendAck(toState);
            return true;
        });
        // When moving to pause or idle, pause the timer.
        this.fsm.onExit(SimSvc.SimState.Ready, function (toState) {
            Winston.warn('Pausing...');
            _this.timer.pause();
            _this.sendAck(toState);
            return true;
        });
        this.fsm.onEnter(SimSvc.SimState.Idle, function (from) {
            _this.message = 'Reset received.';
            _this.reset();
            return true;
        });
        this.on('simSpeedChanged', function () { return _this.startTimer(); });
        // Listen to JOBS
        this.subscribeKey(SimSvc.SimServiceManager.namespace + "." + SimSvc.Keys[SimSvc.Keys.Job], {}, function (topic, message, meta) {
            Winston.info('Received job: ', message);
            if (message.hasOwnProperty('get')) {
                switch (message['get'].toLowerCase()) {
                    case 'scenarios':
                        _this.updateKey(SimSvc.SimServiceManager.namespace + "." + SimSvc.Keys[SimSvc.Keys.Job], Object.keys(_this.availableScenarios), {}, function () { });
                        break;
                    default:
                        Winston.info('Command ' + message['get'] + 'not found.');
                        break;
                }
            }
            if (message.hasOwnProperty('start')) {
                if (message['start'].length > 0) {
                    _this.startScenario(message['start'].toLowerCase());
                }
            }
        });
        // Listen to Sim.SimState keys
        this.subscribeKey(SimSvc.SimServiceManager.namespace + "." + SimSvc.Keys[SimSvc.Keys.SimState], {}, function (topic, message, params) {
            if (message === null)
                return;
            try {
                var simState = (typeof message === 'object') ? message : JSON.parse(message);
                // Winston.info("Received sim state: ", simState);
                if (!simState || simState.id === _this.id)
                    return;
                var state = SimSvc.SimState[simState.state];
                var index = _this.simsNotReady.indexOf(simState.id);
                if (state !== SimSvc.SimState.Ready) {
                    if (index < 0)
                        _this.simsNotReady.push(simState.id);
                }
                else {
                    if (index >= 0)
                        _this.simsNotReady.splice(index, 1);
                }
                _this.sims[simState.id] = simState;
                // Read the upcoming event time of the sim, and check whether it is the first upcoming event of all sims
                if (simState.hasOwnProperty('nextEvent') && simState.nextEvent && state === SimSvc.SimState.Ready) {
                    if (!_this.nextEvent || simState.nextEvent < _this.nextEvent) {
                        _this.nextEvent = simState.nextEvent;
                        Winston.info("SimManager: Next event is " + (new Date(_this.nextEvent)).toLocaleString() + ".");
                    }
                }
                // Listen to sims that move to Exit (when they have exited, we always try to emit a final Exit message).
                if (state === SimSvc.SimState.Exit) {
                    delete _this.sims[simState.id];
                    if (index >= 0)
                        _this.simsNotReady.splice(index, 1);
                }
            }
            catch (e) { }
        });
        // Listen to NextEvent
        this.subscribeKey(SimSvc.SimServiceManager.namespace + "." + SimSvc.Keys[SimSvc.Keys.NextEvent], {}, function (topic, message, params) {
            if (message === null)
                return;
            try {
                var msgObject = (typeof message === 'object') ? message : JSON.parse(message);
                if (!msgObject || !msgObject.next || !_this.nextEvent)
                    return;
                if (_this.continue()) {
                    _this.timer.config({ time: (new Date(_this.nextEvent)).toISOString() });
                    _this.nextEvent = null;
                    _this.publishTime();
                    Winston.info("Forwarded to time: " + _this.timer.getTime().toLocaleString());
                }
                else {
                    Winston.warn("Simulation is not ready to continue yet");
                }
            }
            catch (e) { }
        });
    };
    /**
     * Override the start method to specify your own startup behaviour.
     * Although you could use the init method, at that time the connectors haven't been configured yet.
     */
    SimulationManager.prototype.start = function () {
        _super.prototype.start.call(this);
        this.reset();
        this.initFsm();
    };
    /**
     * Create a new timer and start it.
     * As the start time may have changed, the speed or interval (time step), create a new timer.
     * @method startTimer
     * @return {void}
     */
    SimulationManager.prototype.startTimer = function () {
        var _this = this;
        if (this.timer)
            this.timer.clear();
        this.timer = new HyperTimer({
            time: this.simTime,
            rate: this.simSpeed || 1,
            paced: true
        });
        this.timer.setInterval(function () {
            _this.simTime = _this.timer.getTime();
            if (_this.continue())
                _this.publishTime();
        }, this.simTimeStep * this.simSpeed); // Default every 5 seconds
    };
    /**
     * Check whether we should continue or pause the simulation based on the current conditions.
     * @method continue
     * @return {boolean}        [Returns true if we can continue, false otherwise]
     */
    SimulationManager.prototype.continue = function () {
        if (this.simsNotReady.length === 0) {
            // All sims are ready, so if we are not running, and should be running, continue.
            if (!this.timer.running && this.fsm.currentState === SimSvc.SimState.Ready) {
                this.publishTime(); // Inform others
                this.timer.continue();
            }
            return true;
        }
        // Some sims are not ready, so if we are running, pause.
        if (this.timer.running)
            this.timer.pause();
        return false;
    };
    /**
     * Publish a time message.
     * @method publishTime
     * @return {void}
     */
    SimulationManager.prototype.publishTime = function () {
        this.updateKey(this.simTimeKey, this.timer.getTime().valueOf(), {}, function () { });
    };
    return SimulationManager;
})(SimSvc.SimServiceManager);
exports.SimulationManager = SimulationManager;
//# sourceMappingURL=SimulationManager.js.map
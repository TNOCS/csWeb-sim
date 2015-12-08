var __extends = (this && this.__extends) || function (d, b) {
    for (var p in b) if (b.hasOwnProperty(p)) d[p] = b[p];
    function __() { this.constructor = d; }
    d.prototype = b === null ? Object.create(b) : (__.prototype = b.prototype, new __());
};
var fs = require('fs');
var path = require('path');
var Winston = require('winston');
var TypeState = require('../state/typestate');
var Api = require('../../ServerComponents/api/ApiManager');
var Utils = require('../../ServerComponents/helpers/Utils');
(function (SimCommand) {
    SimCommand[SimCommand["Start"] = 0] = "Start";
    SimCommand[SimCommand["Pause"] = 1] = "Pause";
    SimCommand[SimCommand["Stop"] = 2] = "Stop";
    SimCommand[SimCommand["Run"] = 3] = "Run";
    SimCommand[SimCommand["Finish"] = 4] = "Finish";
    SimCommand[SimCommand["Exit"] = 5] = "Exit";
})(exports.SimCommand || (exports.SimCommand = {}));
var SimCommand = exports.SimCommand;
/** Simulation state */
(function (SimState) {
    SimState[SimState["Idle"] = 0] = "Idle";
    SimState[SimState["Pause"] = 1] = "Pause";
    SimState[SimState["Ready"] = 2] = "Ready";
    SimState[SimState["Busy"] = 3] = "Busy";
    SimState[SimState["Exit"] = 4] = "Exit";
})(exports.SimState || (exports.SimState = {}));
var SimState = exports.SimState;
/** In what state is the (critical) infrastructure */
(function (InfrastructureState) {
    /** 100% functional */
    InfrastructureState[InfrastructureState["Ok"] = 0] = "Ok";
    /** Still working, but partially failing */
    InfrastructureState[InfrastructureState["Stressed"] = 1] = "Stressed";
    /** Not working anymore */
    InfrastructureState[InfrastructureState["Failed"] = 2] = "Failed";
})(exports.InfrastructureState || (exports.InfrastructureState = {}));
var InfrastructureState = exports.InfrastructureState;
/** When the infrastructure is stressed or has failed, what was the cause of its failure. */
(function (FailureMode) {
    FailureMode[FailureMode["None"] = 0] = "None";
    FailureMode[FailureMode["Unknown"] = 1] = "Unknown";
    FailureMode[FailureMode["Flooded"] = 2] = "Flooded";
    FailureMode[FailureMode["LimitedPower"] = 4] = "LimitedPower";
    FailureMode[FailureMode["NoMainPower"] = 8] = "NoMainPower";
    FailureMode[FailureMode["NoBackupPower"] = 16] = "NoBackupPower";
    FailureMode[FailureMode["NoComms"] = 32] = "NoComms";
})(exports.FailureMode || (exports.FailureMode = {}));
var FailureMode = exports.FailureMode;
/** Incident that has happened */
(function (Incident) {
    Incident[Incident["Flooding"] = 0] = "Flooding";
    Incident[Incident["Earthquake"] = 1] = "Earthquake";
    Incident[Incident["Fire"] = 2] = "Fire";
    Incident[Incident["Explosion"] = 3] = "Explosion";
    Incident[Incident["GasDispersion"] = 4] = "GasDispersion";
    Incident[Incident["TerroristAttack"] = 5] = "TerroristAttack";
    Incident[Incident["PowerFailure"] = 6] = "PowerFailure";
    Incident[Incident["CommunicationFailure"] = 7] = "CommunicationFailure";
    Incident[Incident["TrafficAccident"] = 8] = "TrafficAccident";
})(exports.Incident || (exports.Incident = {}));
var Incident = exports.Incident;
// /** Additional events that are emitted, besides the Api.Event */
// export enum Event {
//     TimeChanged,
//     StateChanged
// }
/** Name of the emitted Keys */
(function (Keys) {
    /** For transmitting the simulation state */
    Keys[Keys["SimState"] = 0] = "SimState";
    /** For transmitting the simulation time */
    Keys[Keys["SimTime"] = 1] = "SimTime";
    Keys[Keys["Job"] = 2] = "Job";
    /** Forward to the next event time */
    Keys[Keys["NextEvent"] = 3] = "NextEvent";
})(exports.Keys || (exports.Keys = {}));
var Keys = exports.Keys;
/**
 * Base class for a simulation service. It is not intended to run directly, but only adds time management
 * functionality to the ApiManager.
 */
var SimServiceManager = (function (_super) {
    __extends(SimServiceManager, _super);
    function SimServiceManager(namespace, name, isClient, options) {
        var _this = this;
        if (isClient === void 0) { isClient = false; }
        if (options === void 0) { options = {}; }
        _super.call(this, namespace, name, isClient, options);
        this.isClient = isClient;
        this.options = options;
        this.id = Utils.newGuid();
        this.simSpeed = 1;
        this.simTimeStep = 1000;
        this.simTime = new Date();
        this.simStartTime = new Date();
        Winston.info(this.name + ": Init layer manager (isClient=" + this.isClient + ")");
        this.fsm = new TypeState.FiniteStateMachine(SimState.Idle);
        // Define transitions
        this.fsm.from(SimState.Idle, SimState.Pause).to(SimState.Ready).on(SimCommand.Start);
        this.fsm.from(SimState.Idle).to(SimState.Busy).on(SimCommand.Run);
        this.fsm.from(SimState.Ready).to(SimState.Busy).on(SimCommand.Run);
        this.fsm.from(SimState.Ready).to(SimState.Pause).on(SimCommand.Pause);
        this.fsm.from(SimState.Ready, SimState.Pause, SimState.Busy).to(SimState.Idle).on(SimCommand.Stop);
        this.fsm.from(SimState.Busy).to(SimState.Ready).on(SimCommand.Finish);
        this.fsm.from(SimState.Idle, SimState.Ready, SimState.Busy, SimState.Pause).to(SimState.Exit).on(SimCommand.Exit);
        // Listen to state changes
        this.fsm.onTransition = function (fromState, toState) {
            _this.publishStateChanged(fromState, toState);
        };
        this.fsm.onEnter(SimState.Ready, function (from) {
            if (from === SimState.Idle) {
                _this.simStartTime = new Date(_this.simTime.getTime());
                Winston.info('Set sim start time: ' + _this.simStartTime.toLocaleString());
            }
            return true;
        });
        this.on(Api.Event[Api.Event.KeyChanged], function (key) {
            if (!key.value.hasOwnProperty('type'))
                return;
            switch (key.value['type']) {
                case 'simTime':
                    _this.updateSimulationState(key.value);
                    break;
                case 'job':
                    break;
            }
        });
        // Listen to SimTime keys
        this.subscribeKey(SimServiceManager.namespace + "." + Keys[Keys.SimTime], {}, function (topic, message, meta) {
            _this.updateSimulationState(message);
        });
        // Heartbeat
        setInterval(function () { return _this.sendAck(_this.fsm.currentState); }, 5000);
        this.cleanup(function () { return _this.terminateProcess(); });
    }
    /**
     * Terminate the process cleanly, and let the simulation manager know that you have quit.
     * @method terminateProcess
     * @return {[type]}         [description]
     */
    SimServiceManager.prototype.terminateProcess = function () {
        Winston.info("${this.name}: Terminating process. Bye!");
        this.sendAck(SimState.Exit);
    };
    /**
     * Override the start method to specify your own startup behaviour.
     * Although you could use the init method, at that time the connectors haven't been configured yet.
     */
    SimServiceManager.prototype.start = function () {
        null;
    };
    /**
     * Send a message, acknowledging the fact that we have received a time step and are, depending on the state,
     * ready to move on.
     */
    SimServiceManager.prototype.sendAck = function (curState) {
        var state = {
            id: this.id,
            name: this.name,
            time: this.simTime,
            state: SimState[curState],
            nextEvent: this.nextEvent
        };
        if (this.message)
            state['msg'] = this.message;
        state['pid'] = process.pid;
        state['mem'] = process.memoryUsage();
        Winston.debug("Next event: " + state.nextEvent);
        this.updateKey(SimServiceManager.namespace + "." + Keys[Keys.SimState] + "." + this.name, state, {}, function () { });
    };
    /** Delete all files in the folder */
    SimServiceManager.prototype.deleteFilesInFolder = function (folder) {
        fs.readdir(folder, function (err, files) {
            if (files) {
                files.forEach(function (f) { fs.unlink(path.join(folder, f)); });
            }
        });
    };
    /**
     * Publish a message when the state has changed, so when the sim was busy (and the simulation stopped) and moves
     * to the Ready state, we can continue running the simulation.
     */
    SimServiceManager.prototype.publishStateChanged = function (fromState, toState) {
        Winston.info(this.name + ": transitioning from " + SimState[fromState] + " to " + SimState[toState] + ".");
        this.sendAck(toState);
    };
    /**
     * Set the simulation speed and time.
     */
    SimServiceManager.prototype.updateSimulationState = function (simState) {
        if (typeof simState === 'number') {
            // Simple message, just containing the time.
            this.simTime = new Date(simState);
            this.emit('simTimeChanged');
        }
        else {
            //Winston.info(`${this.name}: simulation time updated ${JSON.stringify(simState, null, 2) }`);
            if (simState.hasOwnProperty('simTime')) {
                this.simTime = new Date(+simState.simTime);
                this.emit('simTimeChanged');
                Winston.info("sim: new time is " + this.simTime);
            }
            if (simState.hasOwnProperty('simSpeed') && this.simSpeed !== +simState.simSpeed) {
                this.simSpeed = +simState.simSpeed;
                this.emit('simSpeedChanged');
                Winston.info("sim: new speed is " + this.simSpeed);
            }
            // if (simState.hasOwnProperty('simTimeStep')) {
            //     this.simTimeStep = +simState.simTimeStep;
            //     this.emit('simTimeStepChanged');
            //     Winston.info(`sim: new time step is ${this.simTimeStep} msec`);
            // }
            if (simState.hasOwnProperty('simCmd')) {
                this.simCmd = SimCommand[simState.simCmd];
                if (typeof this.simCmd === 'undefined') {
                    Winston.warn('${this.name}: Received unknown sim command ' + simState.simCmd);
                    return;
                }
                Winston.info(this.name + ": new command is " + SimCommand[this.simCmd]);
                this.fsm.trigger(this.simCmd);
            }
            else {
                this.sendAck(this.fsm.currentState);
            }
        }
    };
    /** Namespace for the simulation keys, e.g. /Sim/KEYS */
    SimServiceManager.namespace = 'Sim';
    return SimServiceManager;
})(Api.ApiManager);
exports.SimServiceManager = SimServiceManager;
//# sourceMappingURL=SimServiceManager.js.map
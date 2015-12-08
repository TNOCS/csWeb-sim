import fs = require('fs');
import path = require('path');
import Winston = require('winston');
import async = require('async');
import GeoJSON = require('../../ServerComponents/helpers/GeoJSON')
//import TypeState = require('../../ServerComponents/helpers/typestate')
import Api = require('../../ServerComponents/api/ApiManager');
import Utils = require('../../ServerComponents/Helpers/Utils');
import SimSvc = require('../../SimulationService/api/SimServiceManager');
import Grid = require('../../ServerComponents/import/IsoLines');
import _ = require('underscore');

/**
 * Electrical Network Simulator.
 *
 * It listens to floodings: when a flooding occurs, all power substations are checked, and, if flooded,
 * fail to perform their function.
 * Also, in case their dependencies are no longer satisfied, e.g. when (all of) their power supplying
 * substation fails, it will fail too.
 */
export class ElectricalNetworkSim extends SimSvc.SimServiceManager {
    /** Source folder for the original source files */
    private sourceFolder = '';
    private powerLayer: Api.ILayer;
    private powerStations: Api.Feature[] = [];
    private publishedAreas: string[] = [];

    constructor(namespace: string, name: string, public isClient = false, public options: Api.IApiManagerOptions = <Api.IApiManagerOptions>{}) {
        super(namespace, name, isClient, options);

        this.subscribeKey('sim.PowerStationCmd', <Api.ApiMeta>{}, (topic: string, message: string, params: Object) => {
            Winston.info(`Topic: ${topic}, Msg: ${JSON.stringify(message, null, 2) }, Params: ${params ? JSON.stringify(params, null, 2) : '-'}.`)
            if (message.hasOwnProperty('powerStation') && message.hasOwnProperty('state')) {
                var name = message['powerStation'];
                this.powerStations.some(ps => {
                    if (ps.properties.hasOwnProperty('Name') && ps.properties['Name'] !== name) return false;
                    this.setFeatureState(ps, message['state'], SimSvc.FailureMode.Unknown, true);
                    return true;
                });
            }
        });

        this.on(Api.Event[Api.Event.LayerChanged], (changed: Api.IChangeEvent) => {
            if (changed.id !== 'floodsim' || !changed.value) return;
            var layer = <Api.ILayer>changed.value;
            if (!layer.data) return;
            Winston.info('ElecSim: Floodsim layer received');
            Winston.info(`ID  : ${changed.id}`);
            Winston.info(`Type: ${changed.type}`);
            this.flooding(layer);
        });

        this.on(Api.Event[Api.Event.FeatureChanged], (changed: Api.IChangeEvent) => {
            if (!changed.id || !(changed.id === 'powerstations') || !changed.value) return;
            var updateAllFeatures = false;
            if (changed.value.hasOwnProperty('changeAllFeaturesOfType') && changed.value['changeAllFeaturesOfType'] === true) {
                updateAllFeatures = true;
                delete changed.value['changeAllFeaturesOfType'];
            }
            var f = <Api.Feature>changed.value;
            if (!updateAllFeatures) {
                // Update a single feature
                var foundIndex = -1;
                this.powerStations.some((ps, index) => {
                    if (ps.id === f.id) {
                        foundIndex = index;
                    }
                    return (foundIndex > -1);
                });
                if (foundIndex > -1) {
                    this.powerStations[foundIndex] = f;
                    if (this.getFeatureState(f) === SimSvc.InfrastructureState.Failed) {
                        var failedPowerStation = [f.properties['Name']];
                        this.checkDependencies(failedPowerStation);
                    }
                    this.publishPowerSupplyArea(f);
                }
            } else {
                // Update all features of the same featuretype
                let dependencies = {};
                Object.keys(f.properties).forEach((key) => {
                    if (key.indexOf('_dep') === 0) {
                        dependencies[key] = f.properties[key];
                    }
                });
                this.powerStations.forEach((ps, index) => {
                    if (ps.properties['featureTypeId'] === f.properties['featureTypeId']) {
                        Object.keys(dependencies).forEach((dep) => {
                            ps.properties[dep] = dependencies[dep];
                        });
                        if (ps.id !== f.id) {
                            // Don't send update for the selectedFeature or it will loop forever...
                            this.updateFeature(this.powerLayer.id, ps, <Api.ApiMeta>{}, () => { });
                        }
                    }
                });
            }
            Winston.info('ElecSim: Feature update received');
        });
    }

    start(sourceFolder: string) {
        super.start();
        this.sourceFolder = sourceFolder;
        this.reset();
        this.initFSM();
    }

    /**
     * Initialize the FSM, basically setting the simulation start time.
     */
    private initFSM() {

        this.fsm.onEnter(SimSvc.SimState.Idle, (from) => {
            this.reset();
            this.message = 'Network has been reset.'
            return true;
        });

    }

    private flooding(layer: Api.ILayer) {
        var failedPowerStations = this.checkWaterLevel(layer);
        this.checkDependencies(failedPowerStations);
    }

    private checkWaterLevel(layer: Api.ILayer) {
        var getWaterLevel = this.convertLayerToGrid(layer);
        var failedPowerStations: string[] = [];

        // Check is Powerstation is flooded
        for (let i = 0; i < this.powerStations.length; i++) {
            var ps = this.powerStations[i];
            var state = this.getFeatureState(ps);
            if (state === SimSvc.InfrastructureState.Failed) {
                failedPowerStations.push(ps.properties['Name']);
                continue;
            }
            var waterLevel = getWaterLevel(ps.geometry.coordinates);

            // Check the max water level the station is able to resist
            var waterResistanceLevel = 0;
            if (ps.properties.hasOwnProperty('_dep_water')) {
                waterResistanceLevel = +ps.properties['_dep_water'];
            }
            if (waterLevel > waterResistanceLevel) {
                this.setFeatureState(ps, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.Flooded, true);
                failedPowerStations.push(ps.properties['Name']);
            } else if (waterLevel > 0) {
                this.setFeatureState(ps, SimSvc.InfrastructureState.Stressed, SimSvc.FailureMode.Flooded, true);
            }
        }
        return failedPowerStations;
    }

    private checkDependencies(failedPowerStations: string[]) {
        if (failedPowerStations.length === 0) return;
        var additionalFailures = false;
        for (let i = 0; i < this.powerStations.length; i++) {
            var ps = this.powerStations[i];
            if (!ps.properties.hasOwnProperty('_dep_features')) continue;
            var state = this.getFeatureState(ps);
            if (state === SimSvc.InfrastructureState.Failed) continue;
            var dependencies: string[] = ps.properties['_dep_features'];
            var failedDependencies = 0;
            var okDependencies = 0;
            dependencies.forEach(dpName => {
                if (failedPowerStations.indexOf(dpName) >= 0) {
                    failedDependencies++;
                } else {
                    okDependencies++;
                }
            });
            if (failedDependencies === 0) continue;
            if (failedDependencies < (okDependencies + failedDependencies)) {
                this.setFeatureState(ps, SimSvc.InfrastructureState.Stressed, SimSvc.FailureMode.LimitedPower, true);
            } else {
                this.setFeatureState(ps, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.NoMainPower, true);
                failedPowerStations.push(ps.properties["Name"]);
                additionalFailures = true;
            }
        }
        if (additionalFailures) this.checkDependencies(failedPowerStations);
    }

    private convertLayerToGrid(layer: Api.ILayer) {
        var gridParams = <Grid.IGridDataSourceParameters>{};
        Grid.IsoLines.convertEsriHeaderToGridParams(layer, gridParams);
        var gridData = Grid.IsoLines.convertDataToGrid(layer, gridParams);

        return function getWaterLevel(pt: number[]): number {
            var col = Math.floor((pt[0] - gridParams.startLon) / gridParams.deltaLon);
            if (col < 0 || col >= gridData[0].length) return -1;
            var row = Math.floor((pt[1] - gridParams.startLat) / gridParams.deltaLat);
            if (row < 0 || row >= gridData.length) return -1;
            var waterLevel = gridData[row][col];
            return waterLevel;
        }
    }

    /** Reset the state to the original state. */
    private reset() {
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/layers'));
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/keys'));

        this.powerStations = [];
        this.publishedAreas = [];
        // Copy original GeoJSON layers to dynamic layers
        var stationsFile = path.join(this.sourceFolder, 'power_stations.json');
        fs.readFile(stationsFile, (err, data) => {
            if (err) {
                Winston.error(`Error reading ${stationsFile}: ${err}`);
                return;
            }
            let ps = JSON.parse(data.toString());
            this.powerLayer = this.createNewLayer('powerstations', 'Stroomstations', ps.features, 'Elektrische stroomstations');
            this.powerLayer.features.forEach(f => {
                if (!f.id) f.id = Utils.newGuid();
                if (f.geometry.type !== 'Point') return;
                this.setFeatureState(f, SimSvc.InfrastructureState.Ok);
                this.powerStations.push(f);
            });

            this.publishLayer(this.powerLayer);
        });
        this.fsm.currentState = SimSvc.SimState.Ready;
        this.sendAck(this.fsm.currentState);
    }

    /** Set the state and failure mode of a feature, optionally publishing it too. */
    private setFeatureState(feature: Api.Feature, state: SimSvc.InfrastructureState, failureMode: SimSvc.FailureMode = SimSvc.FailureMode.None, publish: boolean = false) {
        feature.properties['state'] = state;
        feature.properties['failureMode'] = failureMode;
        if (!publish) return;
        // Publish feature update
        this.updateFeature(this.powerLayer.id, feature, <Api.ApiMeta>{}, () => { });
        this.publishPowerSupplyArea(feature);
    }

    // Publish PowerSupplyArea layer
    private publishPowerSupplyArea(feature: Api.Feature) {
        var state = this.getFeatureState(feature);
        if (state === SimSvc.InfrastructureState.Failed && feature.properties.hasOwnProperty('powerSupplyArea')
             && this.publishedAreas.indexOf(feature.id) < 0) {
            var psa = new Api.Feature();
            psa.id = Utils.newGuid();
            psa.properties = {
                Name: 'Blackout area',
                featureTypeId: 'AffectedArea'
            };
            psa.geometry = JSON.parse(feature.properties['powerSupplyArea']);
            this.publishedAreas.push(feature.id);
            this.updateFeature(this.powerLayer.id, psa, <Api.ApiMeta>{}, () => { });
        }
    }

    private getFeatureState(feature: Api.Feature) {
        return <SimSvc.InfrastructureState>parseInt(feature.properties['state'], 10);
    }

    private createNewLayer(id: string, title: string, features: Api.Feature[], description?: string) {
        var layer: Api.ILayer = {
            server: this.options.server,
            id: id,
            title: title,
            description: description,
            features: features,
            storage: 'file',
            enabled: true,
            isDynamic: true,
            typeUrl: `${this.options.server}/api/resources/electrical_network`,
            type: 'dynamicgeojson',
        }
        return layer;
    }

    /**
     * Create and publish the layer.
     */
    private publishLayer(layer: Api.ILayer) {
        this.addUpdateLayer(layer, <Api.ApiMeta>{}, () => { });
    }

}
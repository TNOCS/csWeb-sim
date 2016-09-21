import fs = require('fs');
import path = require('path');
import Winston = require('winston');
import async = require('async');

import csweb = require('csweb');

import SimSvc = require('../../SimulationService/api/SimServiceManager');
import _ = require('underscore');

/**
 * HazardousObjectSim
 *
 * It listens to floodings: when a flooding occurs, all hazardous object are checked, and, if flooded,
 * fail to perform their function.
 * Also, in case they experience a blackout, they will fail too.
 */
export class HazardousObjectSim extends SimSvc.SimServiceManager {
    /** Source folder for the original source files */
    private sourceFolder = '';
    private hazardousObjectsLayer: csweb.ILayer;
    private hazardousObjects: csweb.Feature[] = [];
    private upcomingEventTime: number; // milliseconds

    constructor(namespace: string, name: string, public isClient = false, public options: csweb.IApiManagerOptions = <csweb.IApiManagerOptions>{}) {
        super(namespace, name, isClient, options);

        this.on(csweb.Event[csweb.Event.LayerChanged], (changed: csweb.IChangeEvent) => {
            if (changed.id !== 'floodsim' || !changed.value) return;
            var layer = <csweb.ILayer>changed.value;
            if (!layer.data) return;
            Winston.info('HOSim: Floodsim layer received');
            Winston.info(`ID  : ${changed.id}`);
            Winston.info(`Type: ${changed.type}`);
            this.flooding(layer);
        });

        this.on(csweb.Event[csweb.Event.FeatureChanged], (changed: csweb.IChangeEvent) => {
            if (!changed.id || !(changed.id === 'powerstations') || !(changed.id === 'hazardousobjects') || !changed.value) return;
            if (changed.id === 'powerstations') {
                var f = <csweb.Feature>changed.value;
                Winston.info('HOSim: Powerstations feature received');
                this.blackout(f);
            } else if (changed.id === 'hazardousobjects') {
                var updateAllFeatures = false;
                if (changed.value.hasOwnProperty('changeAllFeaturesOfType') && changed.value['changeAllFeaturesOfType'] === true) {
                    updateAllFeatures = true;
                    delete changed.value['changeAllFeaturesOfType'];
                }
                var f = <csweb.Feature>changed.value;
                if (!updateAllFeatures) {
                    // Update a single feature
                    var foundIndex = -1;
                    this.hazardousObjects.some((ho, index) => {
                        if (ho.id === f.id) {
                            foundIndex = index;
                        }
                        return (foundIndex > -1);
                    });
                    if (foundIndex > -1) this.hazardousObjects[foundIndex] = f;
                } else {
                    // Update all features of the same featuretype
                    let dependencies = {};
                    Object.keys(f.properties).forEach((key) => {
                        if (key === 'state' || key.indexOf('_dep') === 0) {
                            dependencies[key] = f.properties[key];
                        }
                    });
                    this.hazardousObjects.forEach((ho, index) => {
                        if (ho.properties['featureTypeId'] === f.properties['featureTypeId']) {
                            Object.keys(dependencies).forEach((dep) => {
                                ho.properties[dep] = dependencies[dep];
                            });
                            if (ho.id !== f.id) {
                                // Don't send update for the selectedFeature or it will loop forever...
                                this.updateFeature(this.hazardousObjectsLayer.id, ho, <csweb.ApiMeta>{}, () => { });
                            }
                        }
                    });
                }
            }
            Winston.info('HoSim: Feature update received');
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
        // Specify the behaviour of the sim.
        this.fsm.onEnter(SimSvc.SimState.Ready, (from) => {
            //Why is this never reached?
            if (from === SimSvc.SimState.Idle) {
                null;
            }
            return true;
        });

        this.fsm.onEnter(SimSvc.SimState.Idle, (from) => {
            this.reset();
            this.message = 'Hazardous objects have been reset.'
            return true;
        });
    }

    private blackout(f: csweb.Feature) {
        var failedObjects = this.checkBlackoutAreas(f);
    }

    private checkBlackoutAreas(f: csweb.Feature) {
        // var totalBlackoutArea = this.concatenateBlackoutAreas(f);
        var totalBlackoutArea = f.geometry;
        var failedObjects: string[] = [];

        // Check if HO is in blackout area
        for (let i = 0; i < this.hazardousObjects.length; i++) {
            var ho = this.hazardousObjects[i];
            var state = this.getFeatureState(ho);
            if (state === SimSvc.InfrastructureState.Failed) {
                failedObjects.push(ho.properties['name']);
                continue;
            }
            // var inBlackout = this.pointInsideMultiPolygon(ho.geometry.coordinates, totalBlackoutArea.coordinates);
            var inBlackout = this.pointInsidePolygon(ho.geometry.coordinates, totalBlackoutArea.coordinates);
            if (inBlackout) {
                this.setFeatureState(ho, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.NoBackupPower, true);
                failedObjects.push(ho.properties['name']);
            }
        }
        return failedObjects;
    }

    private concatenateBlackoutAreas(layer: csweb.ILayer): csweb.Geometry {
        var totalArea: csweb.Geometry = { type: "MultiPolygon", coordinates: [] };
        if (!layer || !layer.features) return totalArea;
        var count = 0;
        layer.features.forEach((f) => {
            if (f.properties && f.properties.hasOwnProperty('featureTypeId') && f.properties['featureTypeId'] === 'AffectedArea') {
                if (f.geometry.type === "Polygon") {
                    totalArea.coordinates.push(f.geometry.coordinates);
                    count += 1;
                }
            }
        });
        Winston.info('Concatenated ' + count + ' blackout areas');
        return totalArea;
    }

    private flooding(layer: csweb.ILayer) {
        var failedObjects = this.checkWaterLevel(layer);
    }

    private checkWaterLevel(layer: csweb.ILayer) {
        var getWaterLevel = this.convertLayerToGrid(layer);
        var failedObjects: string[] = [];

        // Check is ho is flooded
        for (let i = 0; i < this.hazardousObjects.length; i++) {
            var ho = this.hazardousObjects[i];
            var state = this.getFeatureState(ho);
            if (state === SimSvc.InfrastructureState.Failed) {
                failedObjects.push(ho.properties['name']);
                continue;
            }
            var waterLevel = getWaterLevel(ho.geometry.coordinates);
            // Check the max water level the object is able to resist
            var waterResistanceLevel = 0;
            if (ho.properties.hasOwnProperty('dependencies')) {
                ho.properties['dependencies'].forEach((dep) => {
                    var splittedDep = dep.split('#');
                    if (splittedDep.length === 2) {
                        if (splittedDep[0] !== 'water') return;
                        waterResistanceLevel = +splittedDep[1];
                    }
                });
            }
            if (waterLevel > waterResistanceLevel) {
                this.setFeatureState(ho, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.Flooded, true);
                failedObjects.push(ho.properties['name']);
            } else if (waterLevel > 0) {
                this.setFeatureState(ho, SimSvc.InfrastructureState.Stressed, SimSvc.FailureMode.Flooded, true);
            }
        }
        return failedObjects;
    }

    private convertLayerToGrid(layer: csweb.ILayer) {
        var gridParams = <csweb.IGridDataSourceParameters>{};
        csweb.IsoLines.convertEsriHeaderToGridParams(layer, gridParams);
        var gridData = csweb.IsoLines.convertDataToGrid(layer, gridParams);

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

        this.hazardousObjects = [];
        // Copy original GeoJSON layers to dynamic layers
        var objectsFile = path.join(this.sourceFolder, 'hazardous_objects.json');
        fs.readFile(objectsFile, (err, data) => {
            if (err) {
                Winston.error(`Error reading ${objectsFile}: ${err}`);
                return;
            }
            let ho = JSON.parse(data.toString());
            this.hazardousObjectsLayer = this.createNewLayer('hazardousobjects', 'Gevaarlijke objecten', ho.features);
            this.hazardousObjectsLayer.features.forEach((f, ind) => {
                f.id = `haz_obj_${ind}`;
                if (f.geometry.type !== 'Point') return;
                this.setFeatureState(f, SimSvc.InfrastructureState.Ok);
                this.hazardousObjects.push(f);
            });

            this.publishLayer(this.hazardousObjectsLayer);
        });
        this.fsm.currentState = SimSvc.SimState.Ready;
        this.sendAck(this.fsm.currentState);
    }

    /** Set the state and failure mode of a feature, optionally publishing it too. */
    private setFeatureState(feature: csweb.Feature, state: SimSvc.InfrastructureState, failureMode: SimSvc.FailureMode = SimSvc.FailureMode.None, publish: boolean = false) {
        feature.properties['state'] = state;
        feature.properties['failureMode'] = failureMode;
        if (!publish) return;
        // Publish feature update
        this.updateFeature(this.hazardousObjectsLayer.id, feature, <csweb.ApiMeta>{}, () => { });
        // Publish PowerSupplyArea layer
        // if (state === SimSvc.InfrastructureState.Failed && feature.properties.hasOwnProperty('contour')) {
        //     var contour = new csweb.Feature();
        //     contour.id = csweb.newGuid();
        //     contour.properties = {
        //         name: 'Contour area',
        //         featureTypeId: 'AffectedArea'
        //     };
        //     contour.geometry = JSON.parse(feature.properties['contour']);
        //     this.addFeature(this.hazardousObjectsLayer.id, contour, <csweb.ApiMeta>{}, () => { });
        // }
    }

    private getFeatureState(feature: csweb.Feature) {
        return <SimSvc.InfrastructureState>feature.properties['state'];
    }

    private createNewLayer(id: string, title: string, features: csweb.Feature[], description?: string) {
        var layer: csweb.ILayer = {
            server: this.options.server,
            id: id,
            title: title,
            description: description,
            features: features,
            storage: 'file',
            enabled: true,
            isDynamic: true,
            typeUrl: `${this.options.server}/api/resources/hazardous_objects`,
            type: 'dynamicgeojson',
        }
        return layer;
    }

    /**
     * Create and publish the layer.
     */
    private publishLayer(layer: csweb.ILayer) {
        this.addUpdateLayer(layer, <csweb.ApiMeta>{}, () => { });
    }

    /**
     * pointInsidePolygon returns true if a 2D point lies within a polygon of 2D points
     * @param  {number[]}   point   [lat, lng]
     * @param  {number[][]} polygon [[lat, lng], [lat,lng],...]
     * @return {boolean}            Inside == true
     */
    private pointInsidePolygon(point: number[], polygon: number[][][]): boolean {
        // https://github.com/substack/point-in-polygon
        // ray-casting algorithm based on
        // http://www.ecse.rpi.edu/Homepages/wrf/Research/Short_Notes/pnpoly.html
        var x = point[0];
        var y = point[1];
        var p = polygon[0];

        var inside = false;
        for (var i = 0, j = p.length - 1; i < p.length; j = i++) {
            var xi = p[i][0], yi = p[i][1];
            var xj = p[j][0], yj = p[j][1];

            var intersect = ((yi > y) != (yj > y))
                && (x < (xj - xi) * (y - yi) / (yj - yi) + xi);
            if (intersect) inside = !inside;
        }

        return inside;
    }

    /**
     * pointInsideMultiPolygon returns true if a 2D point lies within a multipolygon
     * @param  {number[]}   point   [lat, lng]
     * @param  {number[][][]} polygon [[[lat, lng], [lat,lng]],...]]
     * @return {boolean}            Inside == true
     */
    private pointInsideMultiPolygon(point: number[], multipoly: number[][][][]): boolean {
        // https://github.com/substack/point-in-polygon
        // ray-casting algorithm based on
        // http://www.ecse.rpi.edu/Homepages/wrf/Research/Short_Notes/pnpoly.html
        var inside = false;
        for (var i = 0; i < multipoly.length; i++) {
            var polygon = multipoly[i];
            if (this.pointInsidePolygon(point, polygon)) inside = !inside;
        }
        return inside;
    }

}

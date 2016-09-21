import fs = require('fs');
import path = require('path');
import Winston = require('winston');
import async = require('async');

import csweb = require('csweb');

import SimSvc = require('../../SimulationService/api/SimServiceManager');
import _ = require('underscore');

export interface ChartData {
    name: string;
    values: { x: number, y: number }[];
}

/**
 * RoadSim
 *
 * It listens to floodings: when a flooding occurs, all roads are checked, and, if flooded,
 * fail to perform their function.
 * Also, in case they experience a blackout, they will fail too.
 */
export class RoadSim extends SimSvc.SimServiceManager {
    /** Source folder for the original source files */
    private sourceFolder = 'source';
    private roadObjectsLayer: csweb.ILayer;
    private roadObjects: csweb.Feature[] = [];
    private bedsChartData: ChartData[];
    private upcomingEventTime: number; // milliseconds

    constructor(namespace: string, name: string, public isClient = false, public options: csweb.IApiManagerOptions = <csweb.IApiManagerOptions>{}) {
        super(namespace, name, isClient, options);

        this.on(csweb.Event[csweb.Event.LayerChanged], (changed: csweb.IChangeEvent) => {
            if (changed.id !== 'floodsim' || !changed.value) return;
            var layer = <csweb.ILayer>changed.value;
            if (!layer.data) return;
            Winston.info('Roadsim: Floodsim layer received');
            Winston.info(`ID  : ${changed.id}`);
            Winston.info(`Type: ${changed.type}`);
            this.flooding(layer);
        });

        this.on(csweb.Event[csweb.Event.FeatureChanged], (changed: csweb.IChangeEvent) => {
            if (changed.id !== 'powerstations' || !changed.value) return;
            var f = <csweb.Feature>changed.value;
            Winston.info('RoadSim: Powerstations feature received');
            Winston.info(`ID  : ${changed.id}`);
            Winston.info(`Type: ${changed.type}`);
            this.blackout(f);
        });

        this.on(csweb.Event[csweb.Event.FeatureChanged], (changed: csweb.IChangeEvent) => {
            if (!changed.id || !(changed.id === 'roadobjects') || !changed.value) return;
            var updateAllFeatures = false;
            if (changed.value.hasOwnProperty('changeAllFeaturesOfType') && changed.value['changeAllFeaturesOfType'] === true) {
                updateAllFeatures = true;
                delete changed.value['changeAllFeaturesOfType'];
            }
            var f = <csweb.Feature>changed.value;
            if (!updateAllFeatures) {
                // Update a single feature
                var foundIndex = -1;
                this.roadObjects.some((ro, index) => {
                    if (ro.id === f.id) {
                        foundIndex = index;
                    }
                    return (foundIndex > -1);
                });
                if (foundIndex > -1) this.roadObjects[foundIndex] = f;
            } else {
                // Update all features of the same featuretype
                let dependencies = {};
                Object.keys(f.properties).forEach((key) => {
                    if (key === 'state' || key.indexOf('_dep') === 0) {
                        dependencies[key] = f.properties[key];
                    }
                });
                this.roadObjects.forEach((ro, index) => {
                    if (ro.properties['featureTypeId'] === f.properties['featureTypeId']) {
                        Object.keys(dependencies).forEach((dep) => {
                            ro.properties[dep] = dependencies[dep];
                        });
                        if (ro.id !== f.id) {
                            // Don't send update for the selectedFeature or it will loop forever...
                            this.updateFeature(this.roadObjectsLayer.id, ro, <csweb.ApiMeta>{}, () => { });
                        }
                    }
                });
            }
            Winston.info('RoadSim: Feature update received');
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
            }
            return true;
        });

        this.fsm.onEnter(SimSvc.SimState.Idle, (from) => {
            this.reset();
            this.message = 'Roads have been reset.'
            return true;
        });
    }

    private blackout(f: csweb.Feature) {
        var failedObjects = this.checkBlackoutAreas(f);
        this.checkDependencies(failedObjects);
    }

    private checkBlackoutAreas(f: csweb.Feature) {
        var totalBlackoutArea = f.geometry;
        var failedObjects: string[] = [];

        // Check if ro is in blackout area
        for (let i = 0; i < this.roadObjects.length; i++) {
            var ro = this.roadObjects[i];
            var state = this.getFeatureState(ro);
            if (state === SimSvc.InfrastructureState.Failed) {
                failedObjects.push(ro.properties['name']);
                continue;
            }

            var inBlackout = this.lineInsidePolygon(ro.geometry.coordinates, totalBlackoutArea.coordinates);
            if (inBlackout) {
                this.setFeatureState(ro, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.NoBackupPower, null, true);
                failedObjects.push(ro.properties['name']);
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
        this.checkDependencies(failedObjects);
    }

    private checkWaterLevel(layer: csweb.ILayer) {
        var getWaterLevel = this.convertLayerToGrid(layer);
        var failedObjects: string[] = [];

        // Check is CO is flooded
        for (let i = 0; i < this.roadObjects.length; i++) {
            var co = this.roadObjects[i];
            var state = this.getFeatureState(co);
            if (state === SimSvc.InfrastructureState.Failed) {
                failedObjects.push(co.properties['name']);
                continue;
            }
            // Check maximum water level along the raod segment
            var maxWaterLevel = 0;
            if (co.geometry.type.toLowerCase() !== "linestring") continue;
            co.geometry.coordinates.forEach((segm) => {
                let level = getWaterLevel(segm);
                maxWaterLevel = Math.max(maxWaterLevel, level);
            });
            // Check the max water level the road is able to resist
            var waterResistanceLevel = 0;
            if (co.properties.hasOwnProperty('dependencies')) {
                co.properties['dependencies'].forEach((dep) => {
                    var splittedDep = dep.split('#');
                    if (splittedDep.length === 2) {
                        if (splittedDep[0] === 'water' && co.properties['state'] === SimSvc.InfrastructureState.Ok) {
                            waterResistanceLevel = +splittedDep[1];
                        }
                    }
                });
            }
            // Set the state of the road segment
            if (maxWaterLevel > waterResistanceLevel) {
                this.setFeatureState(co, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.Flooded, null, true);
                failedObjects.push(co.properties['name']);
            } else if (maxWaterLevel > 0) {
                this.setFeatureState(co, SimSvc.InfrastructureState.Stressed, SimSvc.FailureMode.Flooded, null, true);
            }
        }
        return failedObjects;
    }

    private checkDependencies(failedObjects: string[]) {
        if (failedObjects.length === 0) return;
        var additionalFailures = false;
        for (let i = 0; i < this.roadObjects.length; i++) {
            var co = this.roadObjects[i];
            if (!co.properties.hasOwnProperty('dependencies')) continue;
            var state = this.getFeatureState(co);
            if (state === SimSvc.InfrastructureState.Failed) continue;
            var dependencies: string[] = co.properties['dependencies'];
            var failedDependencies = 0;
            dependencies.forEach(dp => {
                if (failedObjects.indexOf(dp) >= 0) failedDependencies++;
            });
            if (failedDependencies === 0) continue;
            if (failedDependencies < dependencies.length) {
                this.setFeatureState(co, SimSvc.InfrastructureState.Stressed, SimSvc.FailureMode.LimitedPower, null, true);
            } else {
                this.setFeatureState(co, SimSvc.InfrastructureState.Failed, SimSvc.FailureMode.NoMainPower, null, true);
                failedObjects.push(co.properties["name"]);
                additionalFailures = true;
            }
        }
        if (additionalFailures) this.checkDependencies(failedObjects);
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

        this.roadObjects = [];
        // Copy original GeoJSON layers to dynamic layers
        var objectsFile = path.join(this.sourceFolder, 'road_objects.json');
        fs.readFile(objectsFile, (err, data) => {
            if (err) {
                Winston.error(`Error reading ${objectsFile}: ${err}`);
                return;
            }
            let ro = JSON.parse(data.toString());
            this.roadObjectsLayer = this.createNewLayer('roadobjects', 'Wegen', ro.features);
            this.roadObjectsLayer.features.forEach((f, ind) => {
                f.id = `road_${ind}`;
                this.setFeatureState(f, SimSvc.InfrastructureState.Ok);
                if (f.geometry.type !== 'LineString') return;
                this.roadObjects.push(f);
            });

            this.publishLayer(this.roadObjectsLayer);
        });
        this.fsm.currentState = SimSvc.SimState.Ready;
        this.sendAck(this.fsm.currentState);
    }

    /** Set the state and failure mode of a feature, optionally publishing it too. */
    private setFeatureState(feature: csweb.Feature, state: SimSvc.InfrastructureState, failureMode: SimSvc.FailureMode = SimSvc.FailureMode.None, failureTime: Date = null, publish: boolean = false) {
        feature.properties['state'] = state;
        feature.properties['failureMode'] = failureMode;
        if (failureTime) feature.properties['willFailAt'] = failureTime.getTime();
        if (!publish) return;
        // Publish feature update
        this.updateFeature(this.roadObjectsLayer.id, feature, <csweb.ApiMeta>{}, () => { });
        // Publish PowerSupplyArea layer
        // if (state === SimSvc.InfrastructureState.Failed && feature.properties.hasOwnProperty('contour')) {
        //     var contour = new csweb.Feature();
        //     contour.id = csweb.newGuid();
        //     contour.properties = {
        //         name: 'Contour area',
        //         featureTypeId: 'AffectedArea'
        //     };
        //     contour.geometry = JSON.parse(feature.properties['contour']);
        //     this.addFeature(this.roadObjectsLayer.id, contour, <csweb.ApiMeta>{}, () => { });
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
            typeUrl: `${this.options.server}/api/resources/road`,
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
     * lineInsideMultiPolygon returns true if a point of a 2D line lies within a multipolygon
     * @param  {number[][]}   line   [][lat, lng], ...]
     * @param  {number[][][]} polygon [[[lat, lng], [lat,lng]],...]]
     * @return {boolean}            Inside == true
     */
    private lineInsidePolygon(line: number[][], polygon: number[][][]): boolean {
        // https://github.com/substack/point-in-polygon
        // ray-casting algorithm based on
        // http://www.ecse.rpi.edu/Homepages/wrf/Research/Short_Notes/pnpoly.html
        var inside = line.some((l) => { return (this.pointInsidePolygon(l, polygon)) });
        return inside;
    }
}

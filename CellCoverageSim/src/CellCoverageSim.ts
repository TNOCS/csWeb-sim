import fs = require('fs');
import path = require('path');
import Winston = require('winston');
import async = require('async');

import csweb = require('csweb');

import SimSvc = require('../../SimulationService/api/SimServiceManager');
import _ = require('underscore');

/**
 * CellCoverageSim
 *
 * It listens to cell towers: when a tower fails, the coverage of the area is updated.
 *
 */
export class CellCoverageSim extends SimSvc.SimServiceManager {
    /** Source folder for the original source files */
    private sourceFolder = '';
    private coverageLayer: csweb.ILayer;
    private communicationObjects: csweb.Feature[] = [];
    /** Dictionary of feature id's and their status (to prevent updating the same object twice) */
    private objectStatuses: { [id: string]: SimSvc.InfrastructureState } = {};
    private upcomingEventTime: number; // milliseconds
    private gridParams: csweb.IGridDataSourceParameters = <csweb.IGridDataSourceParameters>{};
    private gridData: number[][] = [];
    private gridHeader: string;
    private coverageStamp: number[][] = [];
    private isInitialized: boolean = false;

    constructor(namespace: string, name: string, public isClient = false, public options: csweb.IApiManagerOptions = <csweb.IApiManagerOptions>{}) {
        super(namespace, name, isClient, options);

        this.on(csweb.Event[csweb.Event.FeatureChanged], (changed: csweb.IChangeEvent) => {
            if (changed.id !== 'communicationobjects' || !changed.value) return;
            var f = <csweb.Feature>changed.value;
            Winston.info(`CellCovSim: Communication feature received. ID: ${changed.id} Type:${changed.type}`);
            this.updateGrid(f);
            this.publishLayerThrottled();
        });

        this.on(csweb.Event[csweb.Event.LayerChanged], (changed: csweb.IChangeEvent) => {
            if (changed.id !== 'communicationobjects' || !changed.value) return;
            var layer = <csweb.ILayer>changed.value;
            if (!layer.features) return;
            Winston.info(`CellCovSim: Comm objects layer received. ID: ${changed.id} Type:${changed.type}`);
            this.communicationObjects = layer.features;
            this.isInitialized = false;
            this.initCoverageArea();
            this.initCommObjects();
            if (this.isInitialized) {
                this.coverageLayer.data = this.stringifyGrid();
                this.publishLayerThrottled();
            }
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
            this.message = 'Coverage has been reset.'
            return true;
        });
    }

    private initCoverageArea(): void {
        if (_.isEmpty(this.gridParams) || this.isInitialized) return;
        let nRows = this.gridParams.rows;
        let nCols = this.gridParams.columns;

        for (let i = 0; i < nRows; i++) {
            this.gridData[i] = [];
            for (let j = 0; j < nCols; j++) {
                this.gridData[i][j] = 0;
            }
        }

        this.calculateCoverageStamp(25 * this.gridParams.deltaLon);
        this.isInitialized = true;
        Winston.info(`Initialized CellCoverage with ${nRows} rows and ${nCols} columns.`);
    }

    private initCommObjects(): void {
        Winston.info('initCommObjects ' + this.isInitialized + ' objs: ' + this.communicationObjects.length);
        for (let i = 0; i < this.communicationObjects.length; i++) {
            var co = this.communicationObjects[i];
            this.objectStatuses[co.id] = this.getFeatureState(co);
            this.updateGrid(co, true);
        }
    }

    private updateGrid(f: csweb.Feature, init: boolean = false) {
        if (!this.isInitialized) this.initCoverageArea();
        let fLoc = f.geometry.coordinates;
        let fx = Math.floor((fLoc[0] - this.gridParams.startLon) / this.gridParams.deltaLon);
        let fy = Math.floor((fLoc[1] - this.gridParams.startLat) / this.gridParams.deltaLat);
        if (fx < 0 || fx > this.gridParams.columns) return;
        if (fy < 0 || fy > this.gridParams.rows) return;
        var state = +this.getFeatureState(f); // State might be returned as string ("2"), so parse to a number
        if (!this.objectStatuses.hasOwnProperty(f.id)) return console.log(`Unknown feature id ${f.id}`);
        var prevState = <SimSvc.InfrastructureState>this.objectStatuses[f.id];
        if (state === prevState && !init) return;
        if (state !== SimSvc.InfrastructureState.Failed && (prevState === SimSvc.InfrastructureState.Failed || init)) {
            this.applyStamp(fx, fy, 1);
        }
        if (state === SimSvc.InfrastructureState.Failed && prevState !== SimSvc.InfrastructureState.Failed && !init) {
            this.applyStamp(fx, fy, -1);
        }
        this.objectStatuses[f.id] = state;
    }

    /**
    * Calculate a quarter coverage area around location (0,0) in a rectangular grid.
    */
    private calculateCoverageStamp(maxRadius: number) {
        if (this.isInitialized) return;
        var latLonDistance = csweb.GeoExtensions.convertDegreesToMeters(this.gridParams.startLat);
        var latLonFactor = latLonDistance.longitudeLength / latLonDistance.latitudeLength;
        var horizCells = Math.abs(Math.floor(maxRadius / (this.gridParams.deltaLon * latLonFactor)));
        var vertCells = Math.abs(Math.floor(maxRadius / this.gridParams.deltaLat));
        var cellDiam = Math.abs(this.gridParams.deltaLat * this.gridParams.deltaLon * latLonFactor);
        this.coverageStamp = [];

        console.log('Coverage stamp radius: ' + vertCells + ' x ' + horizCells);
        for (var i = 0; i < vertCells; i++) {
            this.coverageStamp[i] = [];
            for (var j = 0; j < horizCells; j++) {
                var radius = Math.sqrt(i * i * this.gridParams.deltaLat * this.gridParams.deltaLat 
                                            + j * j * this.gridParams.deltaLon * latLonFactor * this.gridParams.deltaLon * latLonFactor);
                this.coverageStamp[i][j] = (radius < maxRadius) ? 1 : 0;
            }
        }
    }

    private applyStamp(x, y, val) {
        if (!this.isInitialized) return;
        for (let i = -this.coverageStamp.length + 1; i < this.coverageStamp.length; i++) {
            for (let j = -this.coverageStamp[0].length + 1; j < this.coverageStamp[0].length; j++) {
                if ((x + j) < 0 || (x + j) >= this.gridParams.columns) continue;
                if ((y + i) < 0 || (y + i) >= this.gridParams.rows) continue;
                this.gridData[y + i][x + j] += (val * this.coverageStamp[Math.abs(i)][Math.abs(j)]);
            }
        }
    }

    private stringifyGrid(): string {
        if (!this.isInitialized) return '';
        let nRows = this.gridParams.rows;
        let nCols = this.gridParams.columns;

        var grid = [];
        grid.push(this.gridHeader);
        for (let i = 0; i < nRows; i++) {
            var row = [];
            for (let j = 0; j < nCols; j++) {
                row.push(this.gridData[i][j]);
            }
            grid.push(row.join(' '));
        }
        return grid.join('\n');
    }

    /** Reset the state to the original state. */
    private reset() {
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/layers'));
        this.deleteFilesInFolder(path.join(__dirname, '../public/data/keys'));
        this.isInitialized = false;

        // this.communicationObjects = [];
        this.objectStatuses = {};
        this.gridData = [];
        // Copy original csweb layers to dynamic layers
        var coverageFile = path.join(this.sourceFolder, 'coveragesim.asc');
        fs.readFile(coverageFile, 'utf8', (err, data) => {
            if (err) {
                Winston.error(`Error reading ${coverageFile}: ${err}`);
                return;
            } else {
                this.initLayer(data);
            }
        });
        this.fsm.currentState = SimSvc.SimState.Ready;
        this.sendAck(this.fsm.currentState);
    }

    public initLayer(data: any) {
        this.coverageLayer = this.createCoverageLayer('', 'Coverage');
        this.gridHeader = data;
        this.coverageLayer.data = this.gridHeader;
        this.parseParameters(this.gridHeader);
        this.initCoverageArea();
        this.initCommObjects();
        this.coverageLayer.data = this.stringifyGrid();
        this.publishLayerThrottled();
    }

    private parseParameters(data: string): void {
        this.gridParams = <csweb.IGridDataSourceParameters>{};
        csweb.IsoLines.convertEsriHeaderToGridParams(this.coverageLayer, this.gridParams);
        this.gridData = [];
        this.isInitialized = false;
    }

    private getFeatureState(feature: csweb.Feature) {
        return <SimSvc.InfrastructureState>feature.properties['state'];
    }

    private createCoverageLayer(file: string, description?: string) {
        var layer: csweb.ILayer = {
            server: this.options.server,
            id: 'cellcoverage',
            title: 'Coverage',
            description: description,
            features: [],
            storage: 'file',
            enabled: true,
            isDynamic: true,
            data: '',
            url: file,
            typeUrl: `${this.options.server}/api/resources/coveragetypes`,
            type: 'grid',
            renderType: 'gridlayer',
            dataSourceParameters: <csweb.IGridDataSourceParameters>{
                propertyName: 'h',
                gridType: 'esri',
                projection: 'WGS84',
                legendStringFormat: '{0:#,#}'
            },
            defaultFeatureType: 'coverage',
            defaultLegendProperty: 'h'
        }
        return layer;
    }

    /**
     * Create and publish the layer.
     */
    private publishLayer(layer: csweb.ILayer) {
        layer.quickRefresh = true;
        this.addUpdateLayer(layer, <csweb.ApiMeta>{}, () => { });
    }


    private publishLayerThrottled = _.throttle(() => {
        this.coverageLayer.data = this.stringifyGrid();
        this.publishLayer(this.coverageLayer);
    }, 500, { leading: false, trailing: true });

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

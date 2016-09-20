require('./Helpers/DateUtils');

import express = require('express');
import http = require('http');
import path = require('path');
import Winston = require('winston');

import * as csweb from "csweb";

import FloodSim = require('./FloodSim/src/FloodSim');
import CloudSim = require('./CloudSim/src/CloudSim');
import ElectricalNetworkSim = require('./ElectricalNetworkSim/src/ElectricalNetworkSim');
import CommunicationSim = require('./CommunicationSim/src/CommunicationSim');
import CellCoverageSim = require('./CellCoverageSim/src/CellCoverageSim');
import CriticalObjectSim = require('./CriticalObjectSim/src/CriticalObjectSim');
import RoadSim = require('./RoadSim/src/RoadSim');
import HazardousObjectSim = require('./HazardousObjectSim/src/HazardousObjectSim');
import SimSvc = require('./SimulationService/api/SimServiceManager');
import SimMngr = require('./SimulationManager/src/SimulationManager');


Winston.remove(Winston.transports.Console);
Winston.add(Winston.transports.Console, <Winston.ConsoleTransportOptions>{
    label: 'all',
    colorize: true,
    prettyPrint: true
});

var favicon = require('serve-favicon');
var bodyParser = require('body-parser')
var server = express();

var httpServer = require('http').Server(server);
var cm = new csweb.ConnectionManager(httpServer);
var messageBus = new csweb.MessageBusService();
var config = new csweb.ConfigurationService();

//This line is required when using JX to run the server, or else the input-messages coming from the Excel file will cause an error: https://github.com/jxcore/jxcore/issues/119
//require('http').setMaxHeaderLength(26214400);

// all environments
var port = '4567';
server.set('port', port);
server.use(favicon(__dirname + '/public/favicon.ico'));
//increased limit size, see: http://stackoverflow.com/questions/19917401/node-js-express-request-entity-too-large
server.use(bodyParser.json({ limit: '25mb' })); // support json encoded bodies
server.use(bodyParser.urlencoded({ limit: '25mb', extended: true })); // support encoded bodies

// CORRS: see http://stackoverflow.com/a/25148861/319711
server.use(function(req, res, next) {
    res.header('Access-Control-Allow-Origin', 'http://localhost');
    res.header('Access-Control-Allow-Methods', 'GET');
    res.header('Access-Control-Allow-Headers', 'X-Requested-With, Content-Type');
    next();
});

config.add('server', 'http://localhost:' + port);

var ld = new csweb.LayerDirectory.LayerDirectory(server, cm);
ld.Start();

//var pr = new DynamicProject.DynamicProjectService(server, cm, messageBus);
//pr.Start(server);

var ds = new csweb.DataSource.DataSourceService(cm, 'DataSource');
ds.start();
server.get('/datasource', ds.getDataSource);

server.use(express.static(path.join(__dirname, 'swagger')));

// Create the API service manager and add the services that you need
var apiServiceMgr = new csweb.ApiServiceManager(server, config);
// Resource types
var resourceTypeStore = new csweb.ProjectRepositoryService(new csweb.FolderStore({ storageFolder: 'public/data/resourceTypes' }));
apiServiceMgr.addService(resourceTypeStore);

server.use(express.static(path.join(__dirname, 'public')));

var prefix = SimSvc.SimServiceManager.namespace;

/** Start FloodSim server */
var floodSim = new FloodSim.FloodSim('cs', 'FloodSim', false, <csweb.IApiManagerOptions>{
    server: `${csweb.getIPAddress() }:${port}`,
    mqttSubscriptions: ['cs/keys/Sim/SimTime', 'cs/keys/sim/floodSimCmd']
});
floodSim.init(path.join(path.resolve(__dirname), './FloodSim/public/data'), () => {
    // floodSim.addConnector('rest', new RestAPI.RestAPI(server), {});
    floodSim.addConnector('mqtt', new csweb.MqttAPI('localhost', 1883), {});
    // floodSim.addConnector('file', new FileStorage.FileStorage(path.join(path.resolve(__dirname), './FloodSim/public/data/')), {});
    // floodSim.start();
});

// /** Start CloudSim server */
// var cloudSim = new CloudSim.CloudSim('cs', 'CloudSim', false, <csweb.IApiManagerOptions>{
//     server: `${csweb.getIPAddress() }:${port}`,
//     mqttSubscriptions: ['cs/keys/Sim/SimTime', 'cs/keys/sim/cloudSimCmd']
// });
// cloudSim.init(path.join(path.resolve(__dirname), './CloudSim/public/data'), () => {
//     // cloudSim.addConnector('rest', new RestAPI.RestAPI(server), {});
//     cloudSim.addConnector('mqtt', new csweb.MqttAPI('localhost', 1883), {});
//     // cloudSim.addConnector('file', new FileStorage.FileStorage(path.join(path.resolve(__dirname), './CloudSim/public/data/')), {});
//     // cloudSim.start();
// });

/** Start CommunicationSim server */
var communicationSim = new CommunicationSim.CommunicationSim('cs', 'CommunicationSim', false, <csweb.IApiManagerOptions>{
    server: `${csweb.getIPAddress() }:${port}`,
    mqttSubscriptions: ['cs/keys/Sim/SimTime', 'cs/layers/floodsim', 'cs/layers/powerstations/feature/#', 'cs/layers/communicationobjects/feature/#']
});
communicationSim.init(path.join(path.resolve(__dirname), './CommunicationSim/public/data'), () => {
    // communicationSim.addConnector('rest', new RestAPI.RestAPI(server), {});
    communicationSim.addConnector('mqtt', new csweb.MqttAPI('localhost', 1883), {});
    // communicationSim.addConnector('file', new FileStorage.FileStorage(path.join(path.resolve(__dirname), './CommunicationSim/public/data/')), {});
    // communicationSim.start();
});

/** Start ElectricalNetworkSim server */
var electricalNetworkSim = new ElectricalNetworkSim.ElectricalNetworkSim('cs', 'ElectricalNetworkSim', false, <csweb.IApiManagerOptions>{
    server: `${csweb.getIPAddress() }:${port}`,
    mqttSubscriptions: ['cs/keys/Sim/SimTime', 'cs/layers/floodsim', 'cs/layers/powerstations/feature/#']
});
electricalNetworkSim.init(path.join(path.resolve(__dirname), './ElectricalNetworkSim/public/data'), () => {
    // electricalNetworkSim.addConnector('rest', new RestAPI.RestAPI(server), {});
    electricalNetworkSim.addConnector('mqtt', new csweb.MqttAPI('localhost', 1883), {});
    // electricalNetworkSim.addConnector('file', new FileStorage.FileStorage(path.join(path.resolve(__dirname), './ElectricalNetworkSim/public/data/')), {});
    // electricalNetworkSim.start('./SimulationData/Scenarios/Alblasserwaard/ElectricalNetworkSim/');
});

/** Start CriticalObjectSim server */
var criticalObjectSim = new CriticalObjectSim.CriticalObjectSim('cs', 'CriticalObjectSim', false, <csweb.IApiManagerOptions>{
    server: `${csweb.getIPAddress()}:${port}`,
    mqttSubscriptions: ['cs/keys/Sim/SimTime', 'cs/layers/floodsim', 'cs/layers/powerstations/feature/#', 'cs/layers/criticalobjects/feature/#']
});
criticalObjectSim.init(path.join(path.resolve(__dirname), './CriticalObjectSim/public/data'), () => {
    // criticalObjectSim.addConnector('rest', new RestAPI.RestAPI(server), {});
    criticalObjectSim.addConnector('mqtt', new csweb.MqttAPI('localhost', 1883), {});
    // criticalObjectSim.addConnector('file', new FileStorage.FileStorage(path.join(path.resolve(__dirname), './CriticalObjectSim/public/data/')), {});
    // criticalObjectSim.start();
});

/** Start RoadSim server */
var roadSim = new RoadSim.RoadSim('cs', 'RoadSim', false, <csweb.IApiManagerOptions>{
    server: `${csweb.getIPAddress()}:${port}`,
    mqttSubscriptions: ['cs/keys/Sim/SimTime', 'cs/layers/floodsim', 'cs/layers/powerstations/feature/#', 'cs/layers/roadobjects/feature/#']
});
roadSim.init(path.join(path.resolve(__dirname), './RoadSim/public/data'), () => {
    // roadSim.addConnector('rest', new RestAPI.RestAPI(server), {});
    roadSim.addConnector('mqtt', new csweb.MqttAPI('localhost', 1883), {});
    // roadSim.addConnector('file', new FileStorage.FileStorage(path.join(path.resolve(__dirname), './RoadSim/public/data/')), {});
    // roadSim.start();
});

/** Start HazardousObjectSim server */
var hazardousObjectSim = new HazardousObjectSim.HazardousObjectSim('cs', 'HazardousObjectSim', false, <csweb.IApiManagerOptions>{
    server: `${csweb.getIPAddress()}:${port}`,
    mqttSubscriptions: ['cs/keys/Sim/SimTime', 'cs/layers/floodsim', 'cs/layers/powerstations/feature/#']
});
hazardousObjectSim.init(path.join(path.resolve(__dirname), './HazardousObjectSim/public/data'), () => {
    // hazardousObjectSim.addConnector('rest', new RestAPI.RestAPI(server), {});
    hazardousObjectSim.addConnector('mqtt', new csweb.MqttAPI('localhost', 1883), {});
    // hazardousObjectSim.addConnector('file', new FileStorage.FileStorage(path.join(path.resolve(__dirname), './HazardousObjectSim/public/data/')), {});
    // hazardousObjectSim.start();
});

/** Start CellCoverage server */
var cellCoverageSim = new CellCoverageSim.CellCoverageSim('cs', 'CellCoverageSim', false, <csweb.IApiManagerOptions>{
    server: `${csweb.getIPAddress()}:${port}`,
    mqttSubscriptions: ['cs/keys/Sim/SimTime', 'cs/layers/communicationobjects/feature/#','cs/layers/communicationobjects']
});
cellCoverageSim.init(path.join(path.resolve(__dirname), './CellCoverageSim/public/data'), () => {
    cellCoverageSim.addConnector('mqtt', new csweb.MqttAPI('localhost', 1883), {});
});

var api = new SimMngr.SimulationManager('cs', 'SimulationManager', false,
    {
        'Communication': communicationSim,
        'CellCoverage': cellCoverageSim,
        'Flooding': floodSim,
        'ElectricalNetwork': electricalNetworkSim,
        'CriticalObjects': criticalObjectSim,
        'HazardousObjects': hazardousObjectSim,
        'Roads': roadSim//,
        //'GasCloud': cloudSim
    },
    {
        server: `${csweb.getIPAddress() }:${port}`,
        simDataFolder: 'SimulationData',
        mqttSubscriptions: ['cs/layers/communicationobjects', 'cs/layers/cellcoverage', 'cs/layers/roadobjects', 'cs/layers/floodsim', 'cs/layers/cloudsim', 'cs/layers/powerstations', 'cs/layers/hazardousobjects', 'cs/layers/criticalobjects',
            'cs/layers/roadobjects/feature/#', 'cs/layers/powerstations/feature/#', 'cs/layers/criticalobjects/feature/#', 'cs/layers/hazardousobjects/feature/#', 'cs/layers/communicationobjects/feature/#', 'cs/keys/#']
    });
api.init(path.join(path.resolve(__dirname), 'public/data'), () => {
    api.addConnector('rest', new csweb.RestAPI(server), {});
    api.addConnector('socketio', new csweb.SocketIOAPI(cm), {});
    api.addConnector('mqtt', new csweb.MqttAPI('localhost', 1883), {});
    api.addConnector('file', new csweb.FileStorage(path.join(path.resolve(__dirname), 'public/data/')), {});
    api.start();
});

httpServer.listen(server.get('port'), () => {
    Winston.info('Express server listening on port ' + server.get('port'));
    
    // var restSourceOptions: csweb.IRestDataSourceSettings = {
    //     converterFile: path.join(__dirname, './crowdtasker.js'),
    //     pollIntervalSeconds: 60,
    //     pruneIntervalSeconds: 300,
    //     diffIgnoreGeometry: false,
    //     diffPropertiesBlacklist: [],
    //     url: "http://crowdtasker.ait.ac.at/be/api/",
    //     urlParams: {
    //         api_key: "9319559c3102d1b0205a6f52e854707da076e7de",
    //         attachmentPath: "public\\data\\api\\attachments",
    //         baseUrl: "http://localhost:4567"
    //     }
    // }

    // setTimeout(() => {
    //     var restSource = new csweb.RestDataSource(server, api, 'crowdtasker', '/crowdtasker');
    //     restSource.init(restSourceOptions, (msg: string) => {
    //         Winston.info('RestDataSource: ' + msg);
    //     });
    // }, 4000);
});

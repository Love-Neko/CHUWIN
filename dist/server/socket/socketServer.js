import { WebSocketServer as Server } from 'ws';
import { onConnectionRequest } from './openSocket.js';
// @ts-ignore
import { executeSafely } from '../utility/errorGuard.js';
let WebSocketServer;
function start(httpsServer) {
    WebSocketServer = new Server({ server: httpsServer }); // Create a WebSocket server instance
    // WebSocketServer.on('connection', onConnectionRequest); // Event handler for new WebSocket connections
    WebSocketServer.on('connection', (socket, req) => {
        executeSafely(onConnectionRequest, 'Error caught within websocket on-connection request:', socket, req);
    }); // Event handler for new WebSocket connections
}
export default {
    start,
};

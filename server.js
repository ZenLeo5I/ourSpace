const fs = require('fs');
const https = require('https');
const { WebSocketServer } = require('ws');

const WEBSOCKET_PORT = 4242;

let httpsServer = null;
if (process.env.OURSPACE_HTTPS_ENABLED) {
    const serverConfig = {
        key: fs.readFileSync(process.env.OURSPACE_HTTPS_KEY),
        cert: fs.readFileSync(process.env.OURSPACE_HTTPS_CERT)
    };
    httpsServer = https.createServer(serverConfig)
}

const wsServer = httpsServer
    ? new WebSocketServer({ server: httpsServer })
    : new WebSocketServer({ port: WEBSOCKET_PORT });

console.log("Server ws in ascolto sulla porta " + WEBSOCKET_PORT);

let people = {};
let idCounter = 0;
let incomingMessages = [];

wsServer.on("connection", (webSocket, req) => {
    const clientIp = req.socket.remoteAddress;
    console.log("Nuova connessione da " + clientIp);
    idCounter += 1;
    const id = idCounter + '';
    webSocket.id = id;
    const idMessage = {
        kind: "id",
        id: id,
    };
    webSocket.send(JSON.stringify(idMessage));

    webSocket.on("message", async data => {
        const messagePayLoad = JSON.parse(data);

        incomingMessages.push({
            clientId: webSocket.id,
            payload: messagePayLoad,
        });

        console.log(messagePayLoad);
    });

    webSocket.on("close", data => {
        console.log("Client disconnesso: " + clientIp);
    });
});

function tick() {
    const messages = incomingMessages;
    incomingMessages = [];

    messages.forEach(message => {
        const { clientId, payload } = message;
        if (payload.kind === "init") {
            people[clientId] = {
                x: 0,
                y: 0,
                speed: 5,
                character: payload.character,
            };
        }
        else if (payload.kind === "move") {
            const person = people[clientId];
            person.x = payload.x;
            person.y = payload.y;
        }
    });

    const resetMessage = JSON.stringify({
        kind: "reset",
        people: people,
    });
    wsServer.clients.forEach(
        clientSocket => clientSocket.send(resetMessage)
    );
}

setInterval(tick, 1000 / 20);

if (httpsServer) httpsServer.listen(WEBSOCKET_PORT, () => {
    console.log('Server https in ascolto sulla porta ' + WEBSOCKET_PORT);
});
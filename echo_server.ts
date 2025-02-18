import * as net from "net";

function newConn(socket: net.Socket): void {
    console.log('new connection', socket.remoteAddress, socket.remotePort);
    socket.on('end', () =>  {
        // FIN received.
        console.log('EOF.');
    });
    socket.on('data', (data: Buffer) => {
        console.log('data:', data);
        socket.write(data);

        // end transmission.
        if (data.includes('q')) {
            console.log('closing.');
            socket.end();
        }
    })
}

// create listening socket.
let server = net.createServer();
// register callback for connection event.
server.on('connection', newConn);
server.on('error', (err: Error) => { throw err; });

server.listen({host: '127.0.0.1', port: 1234});
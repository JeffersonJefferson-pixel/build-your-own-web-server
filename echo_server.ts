import * as net from "net";

type TCPConn = {
    socket: net.Socket;
    err: null | Error;
    ended: boolean;
    reader: null | {
        resolve: (value: Buffer) => void,
        reject: (reason: Error) => void,
    }
}

// create wrapper for net.Socket
function soInit(socket: net.Socket): TCPConn {
    const conn: TCPConn = {
        socket, err: null, ended: false, reader: null
    }
    socket.on('data', (data: Buffer) => {
        // pause data event.
        conn.socket.pause();
        // fulfill current read.
        conn.reader!.resolve(data);
        conn.reader = null;
    });
    socket.on('end', () => {
        conn.ended = true;
        // fulfill current read.
        if (conn.reader) {
            conn.reader.resolve(Buffer.from('')); // EOF
            conn.reader = null;
        }
    });
    socket.on('error', (err: Error) => {
        // fulfill current read.
        conn.err = err;
        if (conn.reader) {
            conn.reader.reject(err);
            conn.reader = null;
        }
    })
    return conn;
}

function soRead(conn: TCPConn): Promise<Buffer> {
    // no concurrent calls.
    console.assert(!conn.reader);
    return new Promise((resolve, reject) => {
        if (conn.err) {
            reject(conn.err);
            return;
        }
        if (conn.ended) {
            // EOF.
            resolve(Buffer.from(''));
            return;
        }
        // save callbacks to reader.
        conn.reader = {resolve, reject};
        // resume data event.
        conn.socket.resume();
    });
}

function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
    console.assert(data.length > 0);
    return new Promise((resolve, reject) => {
        if (conn.err) {
            reject(conn.err);
            return;
        }

        conn.socket.write(data, (err?: Error) => {
            if (err) {
                reject(err);
            } else {
                resolve();
            }
        });
    });
}

async function serveClient(socket: net.Socket): Promise<void> {
    const conn: TCPConn = soInit(socket);
    while (true) {
        const data = await soRead(conn);
        if (data.length === 0) {
            console.log('end connection');
            break;
        }

        console.log('data', data);
        await soWrite(conn, data);
    }
}

async function newConn(socket: net.Socket): Promise<void> {
    console.log('new connection', socket.remoteAddress, socket.remotePort);
    try {
        await serveClient(socket);
    } catch (err) {
        console.error('error:', err);
    } finally {
        socket.destroy();
    }
}

// create listening socket.
let server = net.createServer({
    pauseOnConnect: true
});
// register callback for connection event.
server.on('connection', newConn);
server.on('error', (err: Error) => { throw err; });

server.listen({host: '127.0.0.1', port: 1234});
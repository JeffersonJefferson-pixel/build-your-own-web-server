import * as net from "net";
import { DynBuf, bufPush, bufPop } from "./dynamic_buffer";
import { TCPConn, soInit, soRead, soWrite } from "./socket";

// test if message is complete using delimiter.
function cutMessage(buf: DynBuf): null | Buffer {
    // find delimiter.
    const idx = buf.data.subarray(0, buf.length).indexOf('\n');
    if (idx < 0) {
        // no complete message.
        return null;
    }
    // make copy of message and pop data from buffer.
    const msg = Buffer.from(buf.data.subarray(0, idx + 1));
    bufPop(buf, idx + 1);
    return msg;
}

async function serveClient(socket: net.Socket): Promise<void> {
    const conn: TCPConn = soInit(socket);
    const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };
    while (true) {
        // try to get message from buffer.
        // this enables pipelining.
        const msg: null | Buffer = cutMessage(buf);
        if (!msg) {
            // need more data.
            const data: Buffer = await soRead(conn);
            console.log('data', data);
            bufPush(buf, data);
            // check EOF.
            if (data.length === 0) {
                console.log('end connection');
                return;
            }
            // got some data, try again.
            continue;
        }
        
        // process message.
        if (msg.equals(Buffer.from('quit\n'))) {
            await soWrite(conn, Buffer.from('Bye.\n'));
            socket.destroy();
            return;
        } else {
            const reply = Buffer.concat([Buffer.from('Echo: '), msg]);
            // wait for write to complete.
            // while application is waiting, it cannot produce. 
            // this avoids unbounded queue.
            await soWrite(conn, reply);
        }
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
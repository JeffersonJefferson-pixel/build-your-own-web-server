import * as net from "net";

// Dynamic buffer is larger than the appended data to amortize the cost of copying.
// this avoids appending data by concatentation which copy old data.
type DynBuf = {
    data: Buffer,
    length: number, // actual data length.
}

// append data to dynamic buffer.
function bufPush(buf: DynBuf, data: Buffer): void {
    const newLen = buf.length + data.length;
    // check if exceeds capacity.
    if (buf.data.length < newLen) {
        // expand capacity.
        let cap = Math.max(buf.data.length, 32);
        // double capacity until enough.
        while (cap < newLen) {
            cap *= 2;
        }
        // allocate new buffer.
        const grown  = Buffer.alloc(cap);
        buf.data.copy(grown, 0, 0);
        buf.data = grown;
    }
    // append data to buffer.
    data.copy(buf.data, buf.length, 0);
    buf.length = newLen;
}

// pop data from buffer.
function bufPop(buf: DynBuf, len: number): void {
    // move data to the front.
    buf.data.copyWithin(0, len, buf.length);
    buf.length -= len;
}

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
        // this implements backpressure.
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
        // only resumes when event handling completes.
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
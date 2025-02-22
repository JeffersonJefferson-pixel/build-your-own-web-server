import * as net from "net";

export type TCPConn = {
    socket: net.Socket;
    err: null | Error;
    ended: boolean;
    reader: null | {
        resolve: (value: Buffer) => void,
        reject: (reason: Error) => void,
    }
}

// create wrapper for net.Socket
export function soInit(socket: net.Socket): TCPConn {
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

export function soRead(conn: TCPConn): Promise<Buffer> {
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

export function soWrite(conn: TCPConn, data: Buffer): Promise<void> {
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
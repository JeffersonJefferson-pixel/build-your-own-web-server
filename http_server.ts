import * as net from "net";
import { DynBuf, bufPush, bufPop } from "./dynamic_buffer";
import { TCPConn, soInit, soRead, soWrite } from "./socket";

// maximum length of http header.
const kMaxHeaderLen = 1024 * 8;

// interface for reading data from http body.
type BodyReader = {
    length: number,
    // payload body can be abitrarily long
    // use read function instead of buffer.
    // end of data sigaled by an empty buffer.
    read: () => Promise<Buffer>,
}

// http request.
type HTTPReq = {
    method: string,
    uri: Buffer,
    version: string, 
    headers: Buffer[]
}

// http response.
type HTTPRes = {
    code: number,
    headers: Buffer[],
    body: BodyReader,
}

class HTTPError extends Error {
    code: number;

    constructor(code: number, message: string) {
        super(message);
        this.code = code;
    }
}

function splitLines(data: Buffer): Buffer[] {
    const lines: Buffer[] = [];
    // line ends with \r\n
    let idx1 = 0
    let idx2 = data.subarray(idx1, data.length).indexOf('\r\n');
    // loop
    while (idx2 >= 0) {
        const line = Buffer.from(data.subarray(idx1, idx1 + idx2 + 1))
        lines.push(line);
        idx1 += idx2 + 2;
        idx2 = data.subarray(idx1, data.length).indexOf('\r\n');
    }
    return lines;
}

function parseRequestLine(data: Buffer): any[] {
    // get method
    const methodIdx = data.subarray(0, data.length).indexOf(' ');
    if (methodIdx < 0) {
        throw new HTTPError(400, 'No method in request line')
    }
    const method: string = Buffer.from(data.subarray(0, methodIdx)).toString('latin1');
    // get uri
    const uriIdx = data.subarray(methodIdx + 1, data.length).indexOf(' ');
    if (uriIdx < 0) {
        throw new HTTPError(400, 'No uri in request line')
    }
    const uri: Buffer = Buffer.from(data.subarray(methodIdx + 1, methodIdx + uriIdx + 1));
    // get version
    const version: string = Buffer.from(data.subarray(methodIdx + uriIdx + 2, data.length)).toString('latin1');
    
    return [method, uri, version]
}

function validateHeader(data: Buffer): boolean {
    // check Name: value format
    const idx = data.subarray(0, data.length).indexOf(':');
    
    return idx >= 0
}

// parse http request header.
function parseHTTPReq(data: Buffer): HTTPReq {
    // split data into lines.
    const lines: Buffer[] = splitLines(data);
    /// METHOD URI VERSION
    const [method, uri, version] = parseRequestLine(lines[0]);
    // header fields in the format of `Name: value`
    const headers: Buffer[] = []
    for (let i = 1; i < lines.length - 1; i++) {
        // copy.
        const h = Buffer.from(lines[i]);
        if (!validateHeader(h)) {
            throw new HTTPError(400, 'bad field');
        }
        headers.push(h);
    }
    // header ends with an empty line
    console.assert(lines[lines.length - 1].length === 0);
    return {
        method, 
        uri, 
        version, 
        headers
    }
}

// parse http header from buffer.
function cutMessage(buf: DynBuf) {
    // header ends with \r\n\r\n.
    const idx = buf.data.subarray(0, buf.length).indexOf('\r\n\r\n');
    if (idx < 0) {
        if (buf.length >= kMaxHeaderLen) {
            throw new HTTPError(413, 'header is too large');
        }
        // no complete header.
        return null;
    }
    // parse and remove header
    const msg = parseHTTPReq(buf.data.subarray(0, idx + 4));
    bufPop(buf, idx + 4);
    return msg;  
}


// get header by field name.
function fieldGet(headers: Buffer[], key: string): null | Buffer {
    for (let i = 0; i < headers.length; i++) {
        let header = headers[i];
        let idx = header.subarray(0, header.length).indexOf(":");
        let fieldName = header.subarray(0, idx);
        if (fieldName.equals(Buffer.from(key))) {
            return header.subarray(idx + 2, header.length)
        }
    }
    return null
}



// create body reader from socket with a known length.
function readerFromConnLength(conn: TCPConn, buf: DynBuf, remain: number): BodyReader {
    return {
        length: remain,
        read: async (): Promise<Buffer> => {
            if (remain === 0) {
                return  Buffer.from('');
            }
            if (buf.length === 0) {
                // try tp get some data from socket.
                const data = await soRead(conn);
                bufPush(buf, data);
                if (data.length == 0) {
                    // expect more data.
                    throw new Error('Unexpected EOF from HTTP body');
                }
            }
            // consume data from buffer.
            const consume = Math.min(buf.length, remain);
            remain -= consume;
            const data = Buffer.from(buf.data.subarray(0, consume));
            bufPop(buf, consume);
            return data;
        }
    }
}

function parseDec(decimal: string) {
    return parseInt(decimal);
}

// create body reader from http request.
function readerFromReq(conn: TCPConn, buf: DynBuf, req: HTTPReq): BodyReader {
    // get content length from request header.
    let bodyLen = -1;
    const contentLen = fieldGet(req.headers, 'Content-Length');
    if (contentLen) {
        bodyLen = parseDec(contentLen.toString('latin1'));
        if (isNaN(bodyLen)) {
            throw new HTTPError(400, 'bad Content-Length.');
        }
    }
    const bodyAllowed = !(req.method === 'GET' || req.method === 'HEAD');
    const chunked = fieldGet(req.headers, 'Transfer-Encoding')?.equals(Buffer.from('chunked')) || false;
    if (!bodyAllowed && (bodyLen > 0 || chunked)) {
        throw new HTTPError(400, 'HTTP body not allowed.');
    }
    if (!bodyAllowed) {
        bodyLen = 0;
    }

    if (bodyLen >= 0) {
        return readerFromConnLength(conn, buf, bodyLen);
    } else if (chunked) {
        throw new HTTPError(501, 'TODO');
    } else {
        throw new HTTPError(501, 'TODO');
    }
}

// bodyreader from in-memory data.
// for responding with something small.
function readerFromMemory(data: Buffer): BodyReader {
    // returns full data on first call and EOF after that.
    let done = false;
    return {
        length: data.length,
        read: async (): Promise<Buffer> => {
            if (done) {
                // no more data.
                return Buffer.from('');
            } else {
                done = true;
                return data;
            }
        }
    }
}

async function handleReq(req: HTTPReq, body: BodyReader): Promise<HTTPRes> {
    // act on request URI
    let resp: BodyReader;
    switch (req.uri.toString('latin1')) {
        case '/echo':
            resp = body;
            break;
        default:
            resp = readerFromMemory(Buffer.from('hello world.\n'));
            break;
    }

    return {
        code: 200,
        headers: [Buffer.from('Server: my_first_http_server')],
        body: resp,
    };
}

function encodeHTTPResp(resp: HTTPRes): Buffer {
    let buffArr: Buffer[] = []
    let reason: string;
    switch (resp.code) {
        case 200:
            reason = 'OK';
            break;
        case 400:
            reason = 'Bad Request';
            break;
        case 413:
            reason = 'Request Entity Too Large';
            break;
        case 501:
            reason = 'Not Implemented';
            break;
        default:
            throw new Error('Unknown status code');
    }
    let statusLine = Buffer.from(`HTTP/1.1 ${resp.code} ${reason}\r\n`);
    buffArr.push(statusLine);
    for (let i = 0; i < resp.headers.length; i++) {
        buffArr.push(resp.headers[i]);
        buffArr.push(Buffer.from('\r\n'));
    }
    buffArr.push(Buffer.from('\r\n'));
    
    let encoded = Buffer.concat(buffArr);

    return encoded;
}

// send http response through socket.
async function writeHTTPResp(conn: TCPConn, resp: HTTPRes): Promise<void> {
    if (resp.body.length < 0) {
        throw new Error('TODO: chunked encoding');
    }
    // set content-length header.
    console.assert(!fieldGet(resp.headers, 'Content-Length'));
    resp.headers.push(Buffer.from(`Content-Length: ${resp.body.length}`));
    // write header
    await soWrite(conn, encodeHTTPResp(resp));
    // write body.
    while (true) {
        const data = await resp.body.read();
        if (data.length === 0) {
            break;
        }
        await soWrite(conn, data);
    }
}

// server loop.
async function serveClient(conn: TCPConn): Promise<void> {
    const buf: DynBuf = { data: Buffer.alloc(0), length: 0 };
    while (true) {
        // try to get request header from buffer.
        const msg: null | HTTPReq = cutMessage(buf);
        if (!msg) {
            // need more data.
            const data: Buffer = await soRead(conn);
            console.log('data', data);
            bufPush(buf, data);
            // check EOF.
            if (data.length === 0 && buf.length === 0) {
                console.log('end connection');
                return;
            }
            if (data.length === 0) {
                throw new HTTPError(400, 'Expected EOF.')
            }
            // got some data, try again.
            continue;
        }
        
        // process message.
        const reqBody: BodyReader = readerFromReq(conn, buf, msg);
        const res: HTTPRes = await handleReq(msg, reqBody);
        await writeHTTPResp(conn, res);
        // close connection for http/1.0.
        if (msg.version === '1.0') {
            return;
        }
        // loop on bodyreader until all body is read.
        while ((await reqBody.read()).length > 0) {}
    }
}

async function newConn(socket: net.Socket): Promise<void> {
    console.log('new connection', socket.remoteAddress, socket.remotePort);
    const conn: TCPConn = soInit(socket);
    try {
        await serveClient(conn);
    } catch (err) {
        console.error('error:', err);
        if (err instanceof HTTPError) {
            const resp: HTTPRes = {
                code: err.code,
                headers: [],
                body: readerFromMemory(Buffer.from(err.message + '\n'))
            };
            try {
                await writeHTTPResp(conn, resp);
            } catch (err) {
                // ignore.
            }
        }
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
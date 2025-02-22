// Dynamic buffer is larger than the appended data to amortize the cost of copying.
// this avoids appending data by concatentation which copy old data.
export type DynBuf = {
    data: Buffer,
    length: number, // actual data length.
}

// append data to dynamic buffer.
export function bufPush(buf: DynBuf, data: Buffer): void {
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
export function bufPop(buf: DynBuf, len: number): void {
    // move data to the front.
    buf.data.copyWithin(0, len, buf.length);
    buf.length -= len;
}
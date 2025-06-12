# keep-streaming!

A Node.js library for continuous reading and writing across all file types, with customizable retry mechanisms and safe concurrent writes to keep streaming!

Designed for device files (/dev/*) and FIFOs but supports reading from and writing to any file type.

- Chains operations with `.onData()`, `.onFinish()`, `.onError()`.
- Customizable retry strategies for different failure scenarios through retry strategy functions.
- Customizable read timeout.
- Ensures sequential write operations per file.
- No dependencies external to domiot-io or the Node.js standard library.

## Install

```
npm install keep-streaming
```

## Reading from a device file

```
import { File } from 'keep-streaming';

const buttonsDevice = new File('/dev/buttonssim');

let buffer = '';

buttonsDevice.prepareRead()
  .onData((chunk, finish) => {
    buffer += chunk.toString();
    
    let lines = buffer.split(/\r\n|\r|\n/);
    buffer = lines.pop();
    
    lines.forEach(line => {
      // ... 
    });
  })
  .onError(err => console.error('Error reading device: ', err))
  .read();
```

`finish` can be invoked at any time within the `onData` callback to stop reading from the file. Once reading is finished, the `onFinish` callback will be called:

```
buttonsDevice.prepareRead()
  .onData((chunk, finish) => {
    ...
    finish(); // ends the reading.
    ...
  })
  .onFinish(() => {
    console.log('Reading finished');
  })
  .onError(err => console.error('Error reading device: ', err))
  .read();
```

## Writing to a device file

```
import { File } from 'keep-streaming';

const relayDevice = new File('/dev/relaysim');

relayDevice.prepareWrite('001000\r\n')
  .onFinish(() => console.log('Message sent to device'))
  .onError(err => console.error('Device write failed:', err))
  .write();
```

Writing binary data example:
```
const buffer = Buffer.from([0x01, 0x02, 0x03]);
file.prepareWrite(buffer)
  .onFinish(() => console.log('Binary data written'))
  .onError(err => console.error('Write error:', err))
  .write();
```

For character devices (`/dev/ttyUSB0`, `/dev/ttyS0`), attempts to open in read-write mode (`r+`) first. Falls back to write-only mode if needed. For block devices (`/dev/sda1`, `/dev/nvme0n1`), opens in write mode for data writing.

## FIFO reading and writing

FIFOs support true continuous reading.

Before using FIFOs, you need to create them using the `mkfifo` command:

```
mkfifo /tmp/fifocom
```

Writing to FIFO:

```
import { File } from 'keep-streaming';

const fifo = new File('/tmp/fifocom');

const message = {
  timestamp: Date.now(),
  data: 'Hello'
};

fifo.prepareWrite(JSON.stringify(message))
  .onFinish(() => console.log('Message sent to fifo'))
  .onError(err => console.error('Error sending message:', err))
  .write();

```

Reading from FIFO:

```
// Reader process
const fifo = new File('/tmp/fifocom');

fifo.prepareRead()
  .onData((chunk, finish) => {
    const message = JSON.parse(chunk.toString());
    console.log('Received:', message);
    
    // stop reading after receiving STOP
    if (message.data === 'STOP') {
      finish(); // ends the reading.
    }
  })
  .onFinish(() => {
    console.log('Reading finished');
  })
  .onError(err => console.error('Error reading from fifo:', err))
  .read();
```

## Custom retry strategy example

If no custom strategy functions are provided, default ones will be used.

Retry functions must return a delay in milliseconds indicating how long to wait before retrying the operation or throw an Error to abort further retries.
These functions receive three parameters:
- the `error` that triggered the retry,
- the `attempt` number
- an `information` parameter, usually the file path.

```
import { File } from 'keep-streaming';

// custom retry strategy for device availability check.
const deviceExistsRetryStrategy = (error, attempt, information) => {
  if (error.code === 'ENOENT') {
    // For device files, ENOENT often means device not available
    if (attempt >= 10) {
      throw new Error(`Device not available after ${attempt} retries: ${information}`);
    }
    // Longer wait for device to become available
    return 2000 * Math.min(attempt, 5);
  }
  if (attempt >= 5) {
    throw new Error(`Device not available after ${attempt} retries: ${information}`);
  }
  return 1000;
};

const device = new File('/dev/buttonsim', {
  writeFileExistsRetryStrategy: deviceExistsRetryStrategy
});

device.prepareWrite('001000\r\n')
  .onFinish(() => console.log('Message sent to device'))
  .onError(err => console.error('Device write failed:', err))
  .write();
```

Retry strategy functions that can be customized:

**readFileExistsRetryStrategy:** Custom retry strategy for file existence before reading.
**writeFileExistsRetryStrategy:** Custom retry strategy for file existence before writing.
**readFileRetryStrategy:** Custom retry strategy for read stream failures.
**writeFileRetryStrategy:** Custom retry strategy for write stream failures.

## Read timeout configuration

Configure read timeouts for different scenarios:

```
import { File } from 'keep-streaming';

// No timeout (wait indefinitely). Default.
const fileNoTimeout = new File('/path/to/file', { readTimeout: 0 });

// Custom timeout for slow devices
const slowDevice = new File('/dev/sensor', { readTimeout: 60000 }); // 60 seconds

// Quick timeout for responsive files
const quickFile = new File('/tmp/status', { readTimeout: 2000 }); // 2 seconds

slowDevice.prepareRead()
  .onData(chunk => console.log('Sensor data:', chunk.toString()))
  .onError(err => {
    if (err.message.includes('timeout')) {
      console.log('Sensor read timed out after 60 seconds');
    }
  })
  .read();
```


## API Reference

### `new File(filePath, [options])`

Creates a new File instance for the specified path.

#### Parameters

- **`filePath`** `<string>` - Path to the file, device, or pipe.
- **`options`** `<object>` - Configuration options:
  - **`readTimeout`** `<number>` - Optional read timeout in milliseconds. Set to 0 to disable timeout. Default: 0 (disabled).
  - **`readFileExistsRetryStrategy`** `<Function>` - Optional custom retry strategy for file existence before reading.
  - **`writeFileExistsRetryStrategy`** `<Function>` - Optional custom retry strategy for file existence before writing.
  - **`readFileRetryStrategy`** `<Function>` - Optional custom retry strategy for read stream failures.
  - **`writeFileRetryStrategy`** `<Function>` - Optional custom retry strategy for write stream failures.

### `file.prepareRead()`

Creates a read operation that implements continuous reading.

**Returns**: `ReadOperation`: A read operation object.

#### ReadOperation Methods

- **`.onData(callback)`** - `(chunk: Buffer, finish: Function, attempt: number) => void` - **Required** callback for data chunks. The `finish` function can be called to stop reading and trigger the `onFinish` callback.
- **`.onFinish(callback)`** - `() => void` - Optional callback when reading is finished (called when `finish()` is invoked in `onData`).
- **`.onError(callback)`** - `(error: Error) => void` - Error handling.
- **`.read()`** - Executes the read operation, keeps reading continuously.

### `file.prepareWrite(data)`

Creates a write operation that can be executed.

**Returns**: `WriteOperation`: A write operation object.

#### Parameters

- **`data`** `<string | Buffer>` - Data to write.

#### WriteOperation Methods

- **`.onFinish(callback)`** - `() => void` - Optional callback when writing completes.
- **`.onError(callback)`** - `(error: Error) => void` - Error handling.
- **`.write()`** - Executes the write operation. This should be called last in the chain.

import ReadOperation from './ReadOperation.js';
import WriteOperation from './WriteOperation.js';

/**
 * Default retry strategies that are used when no custom strategies are provided
 */

/**
 * Device-aware default retry strategy for file existence check.
 * For device files, handles cases where devices might not be available.
 * For regular files, tries to find the file with exponential backoff.
 */
const defaultReadFileExistsRetryStrategy = (error, attempt, information) => {
  if (error.code === 'ENOENT') {
    if (information.startsWith('/dev/')) {
      // For device files, ENOENT often means device not available
      if (attempt >= 10) {
        throw new Error(`Device not available after ${attempt} retries: ${information}`);
      }
      // Longer wait for device to become available
      return 2000 * Math.min(attempt, 5);
    } else {
      // Regular file behavior
      if (attempt >= 5) {
        throw new Error(`File not found after ${attempt} retries: ${information}`);
      }
      return 1000 * attempt;
    }
  } else {
    throw error;
  }
};

/**
 * Default retry strategy for read operations.
 * Tries to read the file 5 times, if it fails, it throws an error.
 * Waits 100 ms between attempts.
 */
const defaultReadFileRetryStrategy = (error, attempt, information) => {
  if (attempt >= 5) {
    throw new Error(`Failed to read file after ${attempt} retries: ${information}`);
  }
  return 100;
};

/**
 * Device-aware default retry strategy for file existence check (write operations).
 * For device files, handles cases where devices might not be available.
 * For regular files, tries to find the file with exponential backoff.
 */
const defaultWriteFileExistsRetryStrategy = (error, attempt, information) => {
  if (error.code === 'ENOENT') {
    if (information.startsWith('/dev/')) {
      // For device files, ENOENT often means device not available
      if (attempt >= 10) {
        throw new Error(`Device not available after ${attempt} retries: ${information}`);
      }
      // Longer wait for device to become available
      return 2000 * Math.min(attempt, 5);
    } else {
      // Regular file behavior
      if (attempt >= 5) {
        throw new Error(`File not found after ${attempt} retries: ${information}`);
      }
      return 1000 * attempt;
    }
  } else {
    throw error;
  }
};

/**
 * Default retry strategy for write operations.
 */
const defaultWriteFileRetryStrategy = (error, attempt, information) => {
  if (attempt >= 5) {
    throw new Error(`Failed to write to file after ${attempt} retries: ${information}`);
  }
  return 100;
};

/**
 * Main File class for keep-streaming library.
 * Provides a unified interface for reading
 * from and writing to files, device files, and FIFOs
 * with built-in retry strategies and configurable options.

 */
export class File {
  /**
   * Creates a new File instance for the specified path.
   * 
   * @param {string} filePath - Path to the file, device file (/dev/*), or FIFO
   * @param {Object} [options={}] - Configuration options
   * @param {number} [options.readTimeout] - Optional read timeout in milliseconds. Set to 0 to disable. 
   *                                         Default: 0 (disabled)
   * @param {Function} [options.readFileExistsRetryStrategy] - Optional custom retry strategy for file existence before reading
   * @param {Function} [options.writeFileExistsRetryStrategy] - Optional custom retry strategy for file existence before writing
   * @param {Function} [options.readFileRetryStrategy] - Optional custom retry strategy for read stream failures
   * @param {Function} [options.writeFileRetryStrategy] - Optional custom retry strategy for write stream failures
   * 
   * @example
   * // With custom timeout and retry strategy
   * const deviceFile = new File('/dev/sensor', {
   *   readTimeout: 60000, // 60 seconds
   *   readFileExistsRetryStrategy: (error, attempt, path) => {
   *     if (error.code === 'ENOENT' && attempt >= 5) {
   *       throw error;
   *     }
   *     return 2000; // 2 second delay
   *   }
   * });
   */
  constructor(filePath, options = {}) {
    if (typeof filePath !== 'string' || filePath.length === 0) {
      throw new Error('filePath must be a non-empty string.');
    }
    this._filePath = filePath;
    
    // Provide default values for missing options
    this._options = {
      readTimeout: options.readTimeout !== undefined ? options.readTimeout : 0,
      readFileExistsRetryStrategy: options.readFileExistsRetryStrategy || defaultReadFileExistsRetryStrategy,
      writeFileExistsRetryStrategy: options.writeFileExistsRetryStrategy || defaultWriteFileExistsRetryStrategy,
      readFileRetryStrategy: options.readFileRetryStrategy || defaultReadFileRetryStrategy,
      writeFileRetryStrategy: options.writeFileRetryStrategy || defaultWriteFileRetryStrategy
    };
  }

  /**
   * Creates a read operation for this file that can be executed.
   * 
   * @returns {ReadOperation} A ReadOperation instance that can be executed with .read()
   * 
   * @example
   * file.prepareRead()
   *   .onData(chunk => {
   *     // Handle each data chunk (Buffer)
   *     process.stdout.write(chunk);
   *   })
   *   .onFinish(() => {
   *     // Reading finished.
   *     console.log('Reading finished.');
   *   })
   *   .onError(err => {
   *     // Handle any errors
   *     console.error('Read failed:', err.message);
   *   })
   *   .read(); // Execute at the end
   */
  prepareRead() {
    return new ReadOperation(this._filePath, this._options);
  }

  /**
   * Creates a write operation for this file that can be executed.
   * 
   * @param {string|Buffer} data - The data to write to the file
   * @returns {WriteOperation} A WriteOperation instance that can be executed with .write()
   * 
   * @example
   * // Writing string data
   * file.prepareWrite('Hello, World!\n')
   *   .onFinish(() => {
   *     console.log('Write successful');
   *   })
   *   .onError(err => {
   *     console.error('Write failed:', err.message);
   *   })
   *   .write(); // Execute at the end
   * 
   * // Writing binary data
   * const buffer = Buffer.from([0x01, 0x02, 0x03]);
   * file.prepareWrite(buffer)
   *   .onFinish(() => console.log('Binary data written'))
   *   .onError(err => console.error('Write error:', err))
   *   .write(); // Execute at the end
   */
  prepareWrite(data) {
    return new WriteOperation(this._filePath, data, this._options);
  }
}

export default File; 
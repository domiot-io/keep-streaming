import fs from 'fs';
import { createReadStream } from 'fs';


/**
 * Chainable continuous read operation for files,
 * device files, and FIFOs.
 * Supports customizable retry strategies
 * and configurable read timeouts.
 */
class ReadOperation {
  /**
   * Creates a new ReadOperation.
   * @param {string} filePath - Path to the file, device, or FIFO to read from.
   * @param {Object} options - Configuration options.
   * @param {number} [options.readTimeout] - Optional read timeout in milliseconds. 0 to disable. Defaults to 0 (disabled).
   * @param {Function} [options.readFileExistsRetryStrategy] - Optional custom retry strategy for file existence checks.
   * @param {Function} [options.readFileRetryStrategy] - Optional custom retry strategy for read failures.
   */
  constructor(filePath, options) {
    this._filePath = filePath;
    this._options = options;
    this._dataCallback = null;
    this._finishCallback = null;
    this._errorCallback = null;
  }

  /**
   * Sets the callback
   * for handling data chunks.
   * @param {Function} callback - Function to call on each data chunk.
   * @returns {ReadOperation} ReadOperation for chaining.
   */
  onData(callback) {
    this._dataCallback = callback;
    return this;
  }

  /**
   * Sets the callback for when reading
   * is finished.
   * @param {Function} callback - Function to call when reading is finished.
   * @returns {ReadOperation} ReadOperation for chaining.
   */
  onFinish(callback) {
    this._finishCallback = callback;
    return this;
  }

  /**
   * Sets the error callback.
   * @param {Function} callback - Function to call on error.
   * @returns {ReadOperation} ReadOperation for chaining
   */
  onError(callback) {
    this._errorCallback = callback;
    return this;
  }

  /**
   * Executes the read operation.
   * This should be called last in the chain.
   */
  read() {
    this._execute();
  }

  /**
   * Starts the read operation execution.
   * @private
   */
  _execute() {
    this._waitForFileAndRead(1);
  }

  /**
   * Waits for file to exist and then
   * starts reading. Uses the configured
   * retry strategy for file existence checks.
   * @param {number} attempt - Current attempt number
   * @private
   */
  _waitForFileAndRead(attempt) {
    fs.access(this._filePath, fs.constants.F_OK, (err) => {
      if (err) {
        try {
          const delay = this._options.readFileExistsRetryStrategy(err, attempt, this._filePath);
          if (typeof delay === 'number') {
            setTimeout(() => this._waitForFileAndRead(attempt + 1), delay);
          } else {
            setTimeout(() => this._waitForFileAndRead(attempt + 1), 1);
          }
        } catch (error) {
          this._handleError(error);
        }
      } else {
        this._performRead(1);
      }
    });
  }

  /**
   * Performs the actual read operation with retry logic.
   * @param {number} attempt - Current attempt number
   * @private
   */
  _performRead(attempt) {
    
    try {
      const readStream = this._createReadStream();
      let hasReceivedData = false;
      let stopReading = false;
      const isFIFO = this._isFIFO();
      
      const finish = () => {
        if (!stopReading) {
          stopReading = true;
          readStream.destroy();
          if (this._finishCallback) {
            this._finishCallback();
          }
        }
      };
      
      readStream.on('data', (chunk) => {

        // reset attempt counter
        // on first successful data reception
        if (!hasReceivedData) {
          hasReceivedData = true;
          attempt = 1;
        }
        
        if (this._dataCallback && !stopReading) {
          this._dataCallback(chunk, finish, attempt);
        }
      });

      // For FIFOs, handle 'end' event to restart reading (continuous streaming)
      if (isFIFO) {
        readStream.on('end', () => {
          if (!stopReading) {
            // fifo writer disconnected,
            // restart reading to wait for next writer.
            setTimeout(() => this._performRead(attempt), 50);
          }
        });
      } else {
        // For non-FIFOs, keep reading until EOF.
        readStream.on('end', () => {
          if (this._finishCallback) {
            this._finishCallback();
          }
        });
      }

      readStream.on('error', (error) => {
        if (stopReading) return;
        
        try {
          const delay = this._options.readFileRetryStrategy(error, attempt, this._filePath);
          if (typeof delay === 'number') {
            setTimeout(() => this._performRead(attempt + 1), delay);
          } else {
            this._performRead(attempt + 1);
          }
        } catch (err) {
          this._handleError(err);
        }
      });
    } catch (error) {
      this._handleError(error);
    }
  }

  /**
   * Creates a read stream with appropriate flags
   * for continuous reading and timeout protection.
   * @returns {fs.ReadStream} The configured read stream
   * @private
   */
  _createReadStream() {
    const filePath = this._filePath;
    const isDeviceFile = filePath.startsWith('/dev/');
    
    // Get timeout from options, default to 0 (disabled) if not provided
    const timeout = this._options.readTimeout !== undefined ? this._options.readTimeout : 0;
    
    let stream;
    let streamOptions = {};
    
    // Configure all streams
    // for continuous reading.
    streamOptions = {
      flags: 'r',
      autoClose: false,
      highWaterMark: 1024,
      emitClose: false
    };
    
    if (isDeviceFile) {
      // Try to open device files in read-write mode first.
      try {
        streamOptions.flags = 'r+';
        stream = createReadStream(filePath, streamOptions);
      } catch (err) {
        streamOptions.flags = 'r';
        stream = createReadStream(filePath, streamOptions);
      }
    } else {
      // Regular files and FIFOs - all use continuous reading configuration
      stream = createReadStream(filePath, streamOptions);
    }
    
    if (timeout > 0) {
      const timeoutHandle = setTimeout(() => {
        stream.destroy(new Error(`${filePath} read timeout after ${timeout}ms`));
      }, timeout);
      
      stream.on('error', () => clearTimeout(timeoutHandle));
    }
    
    return stream;
  }

  /**
   * Handles errors by calling the registered error callback.
   * @param {Error} error - The error to handle
   * @private
   */
  _handleError(error) {
    if (this._errorCallback) {
      this._errorCallback(error);
    }
  }

  /**
   * Checks if the file path refers to a named pipe (FIFO).
   * @returns {boolean} True if the file is a FIFO, false otherwise
   * @private
   */
  _isFIFO() {
    try {
      const stats = fs.statSync(this._filePath);
      return stats.isFIFO();
    } catch (err) {
      return false;
    }
  }
}

export default ReadOperation; 

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
    this._activeStream = null;
    this._activeTimeouts = new Set();
    this._stopReading = false;
    this._isFinished = false;
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
    return this;
  }

  /**
   * Stops the read operation
   * and cleans up all resources.
   * @returns {ReadOperation} ReadOperation for chaining
   */
  finish() {

    if (!this._stopReading && !this._isFinished) {
      this._stopReading = true;
      this._isFinished = true;
      
      if (this._activeStream) {
        this._activeStream.destroy();

        if (this._isFIFO()) {
          fs.writeFileSync(this._filePath, '');
        }
      }

      this._activeStream = null;
      if (this._finishCallback) {
        this._finishCallback();
      }
    }
  }

  /**
   * Starts the read operation execution.
   * @private
   */
  _execute() {
    if (this._stopReading) return;
    this._waitForFileAndRead(1);
  }

  /**
   * Helper to manage timeouts with tracking
   * @private
   */
  _setTimeout(callback, delay) {
    if (this._stopReading) return;
    
    const timeoutId = setTimeout(() => {
      this._activeTimeouts.delete(timeoutId);
      if (!this._stopReading) {
        callback();
      }
    }, delay);
    
    this._activeTimeouts.add(timeoutId);
    return timeoutId;
  }

  /**
   * Waits for file to exist and then
   * starts reading. Uses the configured
   * retry strategy for file existence checks.
   * @param {number} attempt - Current attempt number
   * @private
   */
  _waitForFileAndRead(attempt) {
    if (this._stopReading) return;
    
    fs.access(this._filePath, fs.constants.F_OK, (err) => {
      if (this._stopReading) return;
      
      if (err) {
        try {
          const delay = this._options.readFileExistsRetryStrategy(err, attempt, this._filePath);
          if (typeof delay === 'number') {
            this._setTimeout(() => this._waitForFileAndRead(attempt + 1), delay);
          } else {
            this._setTimeout(() => this._waitForFileAndRead(attempt + 1), 1);
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
    if (this._stopReading) return;
    
    try {
      const readStream = this._createReadStream();
      this._activeStream = readStream;
      let hasReceivedData = false;
      const isFIFO = this._isFIFO();
      
      const internalFinish = () => {
        this.finish();
      };
      
      readStream.on('data', (chunk) => {
        if (this._stopReading) return;

        // reset attempt counter
        // on first successful data reception
        if (!hasReceivedData) {
          hasReceivedData = true;
          attempt = 1;
        }
        
        if (this._dataCallback && !this._stopReading) {
          this._dataCallback(chunk, internalFinish, attempt);
        }
      });

      // For FIFOs, handle 'end' even
      // to restart reading (continuous streaming)
      if (isFIFO) {
        readStream.on('end', () => {
          if (!this._stopReading) {
            this._activeStream = null;
            // fifo writer disconnected,
            // restart reading to wait for next writer.
            this._setTimeout(() => this._performRead(attempt), 50);
          }
        });
      } else {
        // For non-FIFOs, keep reading until EOF.
        readStream.on('end', () => {
          if (!this._stopReading) {
            this._activeStream = null;
            if (this._finishCallback) {
              this._finishCallback();
            }
          }
        });
      }

      readStream.on('error', (error) => {
        if (this._stopReading) return;
        
        this._activeStream = null;
        
        try {
          const delay = this._options.readFileRetryStrategy(error, attempt, this._filePath);
          if (typeof delay === 'number') {
            this._setTimeout(() => this._performRead(attempt + 1), delay);
          } else {
            this._performRead(attempt + 1);
          }
        } catch (err) {
          this._handleError(err);
        }
      });

      readStream.on('close', () => {
        if (this._activeStream === readStream) {
          this._activeStream = null;
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

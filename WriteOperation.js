import fs from 'fs';
import { createWriteStream } from 'fs';
import { Mutex } from 'another-mutex';

/**
 * Mutex map to ensure sequential
 * writes per file: each file path
 * gets its own mutex to prevent
 * concurrent write operations.
 */
const writeMutexes = new Map();

/**
 * Gets or creates a mutex for one file path.
 * @param {string} filePath - The file path to get a mutex for
 * @returns {Mutex} The mutex instance for this file path
 */
function getMutex(filePath) {
  if (!writeMutexes.has(filePath)) {
    writeMutexes.set(filePath, new Mutex());
  }
  return writeMutexes.get(filePath);
}

/**
 * Represents a chainable write operation for files, device files, and FIFOs.
 * Supports mutex-based sequential writing, customizable retry strategies, and device-specific handling.
 */
class WriteOperation {
  /**
   * Creates a new WriteOperation instance.
   * @param {string} filePath - Path to the file, device, or FIFO to write to
   * @param {string|Buffer} data - Data to write to the file
   * @param {Object} options - Configuration options
   * @param {Function} [options.writeFileExistsRetryStrategy] - Custom retry strategy for file existence checks
   * @param {Function} [options.writeFileRetryStrategy] - Custom retry strategy for write failures
   */
  constructor(filePath, data, options) {
    this._filePath = filePath;
    this._data = data;
    this._options = options;
    this._finishCallback = null;
    this._errorCallback = null;
  }

  /**
   * Sets the callback for when writing completes successfully.
   * @param {Function} callback - Function to call when writing finishes () => void
   * @returns {WriteOperation} This operation for chaining
   */
  onFinish(callback) {
    this._finishCallback = callback;
    return this;
  }

  /**
   * Sets the error callback.
   * @param {Function} callback - Function to call on error (error: Error) => void
   * @returns {WriteOperation} This operation for chaining
   */
  onError(callback) {
    this._errorCallback = callback;
    return this;
  }

  /**
   * Executes the write operation.
   * This should be called last in the chain.
   */
  write() {
    this._execute();
  }

  /**
   * Starts the write operation execution by acquiring a mutex lock.
   * Ensures sequential writes per file path.
   * @private
   */
  _execute() {
    const mtx = getMutex(this._filePath);
    
    mtx.lock()
      .then((unlock) => {
        this._waitForFileAndWrite(1, unlock);
      })
      .catch((err) => {
        this._handleError(err);
      });
  }

  /**
   * Waits for file/directory to be ready and then starts writing.
   * For device files and FIFOs, checks file existence.
   * For regular files, creates parent directories if needed.
   * @param {number} attempt - Current attempt number
   * @param {Function} unlock - Function to unlock the mutex.
   * @private
   */
  _waitForFileAndWrite(attempt, unlock) {
    // For device files and FIFOs, check file existence
    if (this._filePath.startsWith('/dev/') || this._isNamedPipe()) {
      fs.access(this._filePath, fs.constants.F_OK, (err) => {
        if (err) {
          this._handleFileExistsError(err, attempt, unlock);
        } else {
          this._performWrite(1, unlock);
        }
      });
    } else {
      // For regular files, create parent directory if needed
      const dir = this._filePath.substring(0, this._filePath.lastIndexOf('/'));
      if (dir) {
        fs.mkdir(dir, { recursive: true }, (err) => {
          if (err && err.code !== 'EEXIST') {
            this._handleFileExistsError(err, attempt, unlock);
          } else {
            this._performWrite(1, unlock);
          }
        });
      } else {
        this._performWrite(1, unlock);
      }
    }
  }

  /**
   * Handles file existence errors using the configured retry strategy.
   * @param {Error} error - The error that occurred
   * @param {number} attempt - Current attempt number
   * @param {Function} unlock - Function to unlock the mutex.
   * @private
   */
  _handleFileExistsError(error, attempt, unlock) {
    try {
      const delay = this._options.writeFileExistsRetryStrategy(error, attempt, this._filePath);
      if (typeof delay === 'number') {
        setTimeout(() => this._waitForFileAndWrite(attempt + 1, unlock), delay);
      } else {
        setTimeout(() => this._waitForFileAndWrite(attempt + 1, unlock), 1);
      }
    } catch (err) {
      unlock();
      this._handleError(err);
    }
  }

  /**
   * Performs the actual write operation with retry logic.
   * @param {number} attempt - Current attempt number
   * @param {Function} unlock - Function to unlock the mutex.
   * @private
   */
  _performWrite(attempt, unlock) {
    try {
      const writeStream = this._createWriteStream();
      
      writeStream.on('finish', () => {
        unlock();
        if (this._finishCallback) {
          this._finishCallback();
        }
      });

      writeStream.on('error', (error) => {
        try {
          const delay = this._options.writeFileRetryStrategy(error, attempt, this._filePath);
          if (typeof delay === 'number') {
            setTimeout(() => this._performWrite(attempt + 1, unlock), delay);
          } else {
            this._performWrite(attempt + 1, unlock);
          }
        } catch (err) {
          unlock();
          this._handleError(err);
        }
      });

      // Write the data
      if (typeof this._data === 'string') {
        writeStream.write(this._data, 'utf8');
      } else {
        writeStream.write(this._data);
      }
      writeStream.end();
    } catch (error) {
      unlock();
      this._handleError(error);
    }
  }

  /**
   * Creates a write stream with appropriate flags for different file types.
   * Handles device files (character/block), FIFOs, and regular files differently.
   * @returns {fs.WriteStream} The configured write stream
   * @private
   */
  _createWriteStream() {
    const isDeviceFile = this._filePath.startsWith('/dev/');
    
    if (isDeviceFile) {
      const stats = fs.statSync(this._filePath);
      if (stats.isCharacterDevice()) {
        try {
          return createWriteStream(this._filePath, { flags: 'r+' });
        } catch (err) {
          return createWriteStream(this._filePath, { flags: 'w' });
        }
      } else if (stats.isBlockDevice()) {
        return createWriteStream(this._filePath, { flags: 'w' });
      } else {
        return createWriteStream(this._filePath, { flags: 'r+' });
      }
    } else {
      // regular files and FIFOs
      return createWriteStream(this._filePath);
    }
  }

  /**
   * Checks if the file path refers to a named pipe (FIFO).
   * @returns {boolean} True if the file is a FIFO, false otherwise
   * @private
   */
  _isNamedPipe() {
    try {
      const stats = fs.statSync(this._filePath);
      return stats.isFIFO();
    } catch (err) {
      return false;
    }
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
}

export default WriteOperation; 
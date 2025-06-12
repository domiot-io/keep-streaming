import { test, describe } from 'node:test';
import assert from 'node:assert';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { File } from '../index.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const testFilesDir = path.join(__dirname, 'test-files');


if (!fs.existsSync(testFilesDir)) {
  fs.mkdirSync(testFilesDir, { recursive: true });
}

describe('File class tests', () => {
  
  test('constructor should throw error for invalid filePath', (t, done) => {
    assert.throws(() => new File(''), Error, 'filePath must be a non-empty string.');
    assert.throws(() => new File(null), Error);
    assert.throws(() => new File(123), Error);
    done();
  });

  test('constructor should accept valid filePath and options', (t, done) => {
    const file = new File('/test/path');
    assert.ok(file instanceof File);
    
    const fileWithOptions = new File('/test/path', {
      readTimeout: 5000,
      readFileExistsRetryStrategy: () => 100
    });
    assert.ok(fileWithOptions instanceof File);
    done();
  });

  test('should read existing regular file successfully', (t, done) => {
    const testFile = path.join(testFilesDir, 'read-test.txt');
    const testContent = 'Hello, World!';
    
    fs.writeFileSync(testFile, testContent);
    
    const file = new File(testFile);
    let receivedData = '';
    let dataReceived = false;
    
    file.prepareRead()
      .onData(chunk => {
        receivedData += chunk.toString();
        if (!dataReceived && receivedData === testContent) {
          dataReceived = true;
        }
      })
      .onFinish(() => {
        assert.equal(receivedData, testContent);
        fs.unlinkSync(testFile);
        done();
      })
      .onError(err => {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        done(err);
      })
      .read();
  });

  test('should write to file successfully', (t, done) => {
    const testFile = path.join(testFilesDir, 'write-test.txt');
    const testContent = 'Test write content';
    
    const file = new File(testFile);
    
    file.prepareWrite(testContent)
      .onFinish(() => {
        const writtenContent = fs.readFileSync(testFile, 'utf8');
        assert.equal(writtenContent, testContent);
        fs.unlinkSync(testFile);
        done();
      })
      .onError(err => {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        done(err);
      })
      .write();
  });

  test('should write binary data successfully', (t, done) => {
    const testFile = path.join(testFilesDir, 'binary-test.dat');
    const testBuffer = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    
    const file = new File(testFile);
    
    file.prepareWrite(testBuffer)
      .onFinish(() => {
        const writtenBuffer = fs.readFileSync(testFile);
        assert.deepEqual(writtenBuffer, testBuffer);
        fs.unlinkSync(testFile);
        done();
      })
      .onError(err => {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        done(err);
      })
      .write();
  });

  test('should create parent directories for normal files', (t, done) => {
    const testDir = path.join(testFilesDir, 'nested', 'deep');
    const testFile = path.join(testDir, 'nested-write-test.txt');
    const testContent = 'Nested write test';
    
    const file = new File(testFile);
    
    file.prepareWrite(testContent)
      .onFinish(() => {
        assert.ok(fs.existsSync(testFile));
        const writtenContent = fs.readFileSync(testFile, 'utf8');
        assert.equal(writtenContent, testContent);
        fs.rmSync(path.join(testFilesDir, 'nested'), { recursive: true, force: true });
        done();
      })
      .onError(err => {
        fs.rmSync(path.join(testFilesDir, 'nested'), { recursive: true, force: true });
        done(err);
      })
      .write();
  });

  test('should use default retry strategy to handle read error for non-existent file', (t, done) => {
    const nonExistentFile = path.join(testFilesDir, 'non-existent-file.txt');
    const file = new File(nonExistentFile);
    
    file.prepareRead()
      .onData(() => {
        done(new Error('Should not receive data for non-existent file'));
      })
      .onError(err => {
        assert.ok(err instanceof Error);
        assert.ok(err.message.includes('retries'));
        done();
      })
      .read();
  });

  test('should respect custom readTimeout option', (t, done) => {
    const testFile = path.join(testFilesDir, 'timeout-test.txt');
    fs.writeFileSync(testFile, 'test content');
    
    const file = new File(testFile, { readTimeout: 1 });
    
    file.prepareRead()
      .onData(() => {
        // do nothing
      })
      .onError(err => {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        if (err.message.includes('timeout')) {
          done(); // timeout
        } else {
          done(err);
        }
      })
      .read();
  });

  test('should use custom retry strategies', (t, done) => {
    const testFile = path.join(testFilesDir, 'custom-retry-test.txt');
    let retryCount = 0;
    
    const customRetryStrategy = (error, attempt, filePath) => {
      retryCount++;
      if (attempt >= 2) {
        throw new Error('Custom retry limit reached');
      }
      return 10; // ms
    };
    
    const file = new File(testFile, {
      readFileExistsRetryStrategy: customRetryStrategy
    });
    
    file.prepareRead()
      .onData(() => {
        done(new Error('Should not receive data for non-existent file'));
      })
      .onError(err => {
        assert.ok(err.message.includes('Custom retry limit reached'));
        assert.ok(retryCount >= 2);
        done();
      })
      .read();
  });

  test('should handle FIFO read/write', (t, done) => {
    const fifoPath = path.join(testFilesDir, 'test-fifo');
    
    if (fs.existsSync(fifoPath)) {
      fs.unlinkSync(fifoPath);
    }
    
    if (typeof fs.mkfifoSync !== 'function') {
      done();
      return;
    }
    
    try {
      // create FIFO
      fs.mkfifoSync(fifoPath);
      
      const file = new File(fifoPath);
      const testData = 'FIFO test data';
      
      let readData = '';
      let dataReceived = false;
      const readTimeout = setTimeout(() => {
        done(new Error('FIFO read timeout'));
      }, 5000);
      
      file.prepareRead()
        .onData(chunk => {
          readData += chunk.toString();
          if (!dataReceived && readData.includes(testData)) {
            dataReceived = true;
            clearTimeout(readTimeout);
            
            setTimeout(() => {
              assert.ok(readData.includes(testData));
              fs.unlinkSync(fifoPath);
              done();
            }, 100);
          }
        })
        .onError(err => {
          clearTimeout(readTimeout);
          if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
          done(err);
        })
        .read();
      

      setTimeout(() => {
        file.prepareWrite(testData)
          .onFinish(() => {
            // ...
          })
          .onError(err => {
            clearTimeout(readTimeout);
            if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
            done(err);
          })
          .write();
      }, 100);
      
    } catch (err) {
      done();
    }
  });

  test('should handle multiple sequential operations on same file', (t, done) => {
    const testFile = path.join(testFilesDir, 'sequential-test.txt');
    const file = new File(testFile);
    
    let step = 0;
    
    file.prepareWrite('First write')
      .onFinish(() => {
        step++;
        assert.equal(step, 1);
        
        file.prepareWrite('Second write')
          .onFinish(() => {
            step++;
            assert.equal(step, 2);
            
            let readData = '';
            let dataReceived = false;
            
            file.prepareRead()
              .onData(chunk => {
                readData += chunk.toString();
                if (!dataReceived && readData === 'Second write') {
                  dataReceived = true;
                  setTimeout(() => {
                    step++;
                    assert.equal(step, 3);
                    assert.equal(readData, 'Second write');
                    fs.unlinkSync(testFile);
                    done();
                  }, 100);
                }
              })
              .onError(err => {
                if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
                done(err);
              })
              .read();
          })
          .onError(err => {
            if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
            done(err);
          })
          .write();
      })
      .onError(err => {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        done(err);
      })
      .write();
  });

  test('should handle large file operations', (t, done) => {
    const testFile = path.join(testFilesDir, 'large-file-test.txt');
    const largeContent = 'A'.repeat(1000000); // 1MB
    
    const file = new File(testFile);
    
    file.prepareWrite(largeContent)
      .onFinish(() => {
        let readContent = '';
        let dataReceived = false;
        
        file.prepareRead()
          .onData(chunk => {
            readContent += chunk.toString();
            if (!dataReceived && readContent.length === largeContent.length) {
              dataReceived = true;
              setTimeout(() => {
                assert.equal(readContent.length, largeContent.length);
                assert.equal(readContent, largeContent);
                fs.unlinkSync(testFile);
                done();
              }, 100);
            }
          })
          .onError(err => {
            if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
            done(err);
          })
          .read();
      })
      .onError(err => {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        done(err);
      })
      .write();
  });

  test('should handle empty file operations', (t, done) => {
    const testFile = path.join(testFilesDir, 'empty-file-test.txt');
    const file = new File(testFile);
    
    file.prepareWrite('')
      .onFinish(() => {
        let readContent = '';
        
        const timeout = setTimeout(() => {
          assert.equal(readContent, '');
          fs.unlinkSync(testFile);
          done();
        }, 200);
        
        file.prepareRead()
          .onData(chunk => {
            readContent += chunk.toString();
            clearTimeout(timeout);
            setTimeout(() => {
              assert.equal(readContent, '');
              fs.unlinkSync(testFile);
              done();
            }, 100);
          })
          .onError(err => {
            clearTimeout(timeout);
            if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
            done(err);
          })
          .read();
      })
      .onError(err => {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        done(err);
      })
      .write();
  });

  test('should handle device file paths correctly', (t, done) => {
    // test with /dev/null, it should be available on unix systems.
    const file = new File('/dev/null');
    
    file.prepareWrite('test data to null device')
      .onFinish(() => {
        // writing to /dev/null should succeed.
        done();
      })
      .onError(err => {
        // /dev/null not available, skip test.
        if (err.code === 'ENOENT' || err.code === 'EACCES') {
          done();
        } else {
          done(err);
        }
      })
      .write();
  });

  test('should handle concurrent writes to same file with mutex', (t, done) => {
    const testFile = path.join(testFilesDir, 'concurrent-test.txt');
    const file = new File(testFile);
    
    let writeCount = 0;
    let finishCount = 0;
    const totalWrites = 3;
    
    const checkCompletion = () => {
      finishCount++;
      if (finishCount === totalWrites) {
        let readContent = '';
        let dataReceived = false;
        
        file.prepareRead()
          .onData(chunk => {
            readContent += chunk.toString();
            if (!dataReceived) {
              dataReceived = true;
              setTimeout(() => {
                const validContents = ['Write 1', 'Write 2', 'Write 3'];
                assert.ok(validContents.includes(readContent));
                fs.unlinkSync(testFile);
                done();
              }, 100);
            }
          })
          .onError(err => {
            if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
            done(err);
          })
          .read();
      }
    };
    
    // Multiple concurrent writes.
    for (let i = 1; i <= totalWrites; i++) {
      file.prepareWrite(`Write ${i}`)
        .onFinish(checkCompletion)
        .onError(err => {
          if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
          done(err);
        })
        .write();
    }
  });

  test('should handle write with different data types', (t, done) => {
    const testFile = path.join(testFilesDir, 'data-types-test.txt');
    const file = new File(testFile);
    
    let step = 0;
    
    // Test with string.
    file.prepareWrite('string data')
      .onFinish(() => {
        step++;
        
        // test with Buffer.
        const bufferData = Buffer.from('buffer data', 'utf8');
        file.prepareWrite(bufferData)
          .onFinish(() => {
            step++;
            
            let readContent = '';
            let dataReceived = false;
            
            file.prepareRead()
              .onData(chunk => {
                readContent += chunk.toString();
                if (!dataReceived && readContent === 'buffer data') {
                  dataReceived = true;
                  setTimeout(() => {
                    assert.equal(readContent, 'buffer data');
                    assert.equal(step, 2);
                    fs.unlinkSync(testFile);
                    done();
                  }, 100);
                }
              })
              .onError(err => {
                if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
                done(err);
              })
              .read();
          })
          .onError(err => {
            if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
            done(err);
          })
          .write();
      })
      .onError(err => {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        done(err);
      })
      .write();
  });

  test('should handle rapid successive writes', (t, done) => {
    const testFile = path.join(testFilesDir, 'rapid-ops-test.txt');
    const file = new File(testFile);
    
    let operationCount = 0;
    const totalOperations = 5000;
    
    const performOperation = (index) => {
      if (index >= totalOperations) {
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        done();
        return;
      }
      
      file.prepareWrite(`Operation ${index}`)
        .onFinish(() => {
          operationCount++;
          performOperation(index + 1);
        })
        .onError(err => {
          if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
          done(err);
        })
        .write();
    };
    
    performOperation(0);
  });

  test('should handle FIFO continuous reading', (t, done) => {
    const fifoPath = path.join(testFilesDir, 'continuous-fifo');
    
    if (fs.existsSync(fifoPath)) {
      fs.unlinkSync(fifoPath);
    }
    
    if (typeof fs.mkfifoSync !== 'function') {
      done();
      return;
    }
    
    try {
      fs.mkfifoSync(fifoPath);
      
      const file = new File(fifoPath);
      let readDataChunks = [];
      let writeCount = 0;
      
      file.prepareRead()
        .onData(chunk => {
          readDataChunks.push(chunk.toString());
        })
        .onError(err => {
          if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
          done(err);
        })
        .read();
      
      const writeData = (data, delay) => {
        setTimeout(() => {
          file.prepareWrite(data)
            .onFinish(() => {
              writeCount++;
              
              if (writeCount === 3) {
                setTimeout(() => {
                  assert.equal(readDataChunks.length, 3);
                  assert.equal(readDataChunks[0], 'First write\n');
                  assert.equal(readDataChunks[1], 'Second write\n');
                  assert.equal(readDataChunks[2], 'Third write\n');
                  
                  if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
                  done();
                }, 200);
              }
            })
            .onError(err => {
              if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
              done(err);
            })
            .write();
        }, delay);
      };
      
      writeData('First write\n', 100);
      writeData('Second write\n', 500);
      writeData('Third write\n', 1000);
      
    } catch (err) {
      if (err.code === 'ENOTSUP' || err.code === 'EPERM') {
        // FIFOs not supported, skip.
        done();
      } else {
        done(err);
      }
    }
  });

  test('should reset read attempt counter after successful data reception', (t, done) => {
    const testFile = path.join(testFilesDir, 'attempt-reset-test.txt');
    const testContent = 'Test content';
    
    // Start without the file to trigger initial retries
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
    
    let attemptNumbers = [];
    let retryCallCount = 0;
    let dataReceived = false;
    let testCompleted = false;
    
    // Custom retry strategy that captures attempt numbers and controls test flow
    const trackingRetryStrategy = (error, attempt, filePath) => {
      if (testCompleted) return; // Prevent further processing if test is done
      
      retryCallCount++;
      attemptNumbers.push(attempt);
      
      // Let it retry twice, then create file for success
      if (retryCallCount == 1) {
        console.log('first retry, attempt = ', attempt);
        assert.equal(attempt, 1, 'First retry should start with attempt 1');
        return 100; // Continue retrying
      } else if (retryCallCount == 2) {
        console.log('second retry, attempt = ', attempt);
        assert.equal(attempt, 2, 'Second retry should be attempt 2');
        // Create the file so next retry succeeds
        fs.writeFileSync(testFile, testContent);
        return 100; // Continue retrying
      }
      
      return 100;
    };
    
    const file = new File(testFile, {
      readFileExistsRetryStrategy: trackingRetryStrategy
    });
    
    file.prepareRead()
      .onData((chunk, finish, attempt) => {
        if (testCompleted) return; // Prevent further processing if test is done
        
        if (!dataReceived && chunk.toString() === testContent) {
          dataReceived = true;
          testCompleted = true;
          console.log('data received (attempt should reset to 1), attempt = ', attempt);
          
          // Check that attempt counter was reset to 1 after successful data reception
          assert.equal(attempt, 1, 'Attempt counter should be reset to 1 after successful data reception');
          
          // Verify the complete attempt sequence from retries
          assert.equal(attemptNumbers[0], 1, 'First retry attempt should be 1');
          assert.equal(attemptNumbers[1], 2, 'Second retry attempt should be 2');
          assert.ok(dataReceived, 'Should have received data successfully');
          
          if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
          done();
        }
      })
      .onError(err => {
        if (testCompleted) return;
        
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);

        if (!testCompleted) {
          testCompleted = true;
          done(err);
        }
      })
      .read();
    
    // Safety timeout
    setTimeout(() => {
      if (!testCompleted) {
        testCompleted = true;
        if (fs.existsSync(testFile)) fs.unlinkSync(testFile);
        done(new Error('Test timeout'));
      }
    }, 30000);
  });


  test('should handle FIFO continuous reading.', (t, done) => {
    const fifoPath = path.join(testFilesDir, 'continuous-disconnect-fifo');
    
    if (fs.existsSync(fifoPath)) {
      fs.unlinkSync(fifoPath);
    }
    
    if (typeof fs.mkfifoSync !== 'function') {
      done();
      return;
    }
    
    try {
      fs.mkfifoSync(fifoPath);
      
      const file = new File(fifoPath);
      let readDataChunks = [];
      let writeCount = 0;
      
      file.prepareRead()
        .onData((chunk, finish) => {
          readDataChunks.push(chunk.toString());
          console.log('FIFO received:', chunk.toString().trim());
        })
        .onError(err => {
          if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
          done(err);
        })
        .read();
      

      const writeData = (data, delay) => {
        setTimeout(() => {
          const writeFile = new File(fifoPath);
          writeFile.prepareWrite(data)
            .onFinish(() => {
              writeCount++;
              console.log(`Write ${writeCount} completed: ${data.trim()}`);
              
              if (writeCount === 4) {

                setTimeout(() => {
                  assert.equal(readDataChunks.length, 4);
                  assert.equal(readDataChunks[0], 'First write\n');
                  assert.equal(readDataChunks[3], 'Second write\n');
                  assert.equal(readDataChunks[4], 'Third write\n');
                  assert.equal(readDataChunks[5], 'Fourth write\n');
                  assert.equal(readDataChunks[6], 'Fifth write\n');
                  if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
                  done();
                }, 300);
              }
            })
            .onError(err => {
              if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
              done(err);
            })
            .write();
        }, delay);
      };
      
      // Write with different delays to test writer disconnection/reconnection
      writeData('First write\n', 1);
      writeData('write\n', 1);
      writeData('write\n', 1);
      writeData('Second write\n', 10);
      writeData('Third write\n', 100);
      writeData('Fourth write\n', 1000);
      writeData('Fifth write\n', 3000);
      
    } catch (err) {
      if (err.code === 'ENOTSUP' || err.code === 'EPERM') {
        // FIFOs not supported, skip.
        done();
      } else {
        done(err);
      }
    }
  });



  test('should call onFinish when finish is invoked in onData.', (t, done) => {

    const fifoPath = path.join(testFilesDir, 'finish-fifo');
    
    if (fs.existsSync(fifoPath)) {
      fs.unlinkSync(fifoPath);
    }
    
    if (typeof fs.mkfifoSync !== 'function') {
      done();
      return;
    }
    
    try {
      fs.mkfifoSync(fifoPath);
      
      const file = new File(fifoPath);
      let writeCount = 0;
      let dataReceived = false;
      let finishCalled = false;
      
      file.prepareRead()
        .onData((chunk, finish) => {
          dataReceived = true;
          finish();
        })
        .onFinish(() => {
          finishCalled = true;
          assert.ok(dataReceived, 'Should have received data before finish');
          assert.ok(finishCalled, 'onFinish should be called');
          if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
          done();
        })
        .onError(err => {
          if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
          done(err);
        })
        .read();
      

      const writeData = (data, delay) => {
        setTimeout(() => {
          const writeFile = new File(fifoPath);
          writeFile.prepareWrite(data)
            .onError(err => {
              if (fs.existsSync(fifoPath)) fs.unlinkSync(fifoPath);
              done(err);
            })
            .write();
        }, delay);
      };
      
      writeData('First write\n', 1);
      writeData('write\n', 1);
      writeData('write\n', 1);
      writeData('Second write\n', 10);
      writeData('Third write\n', 100);
      writeData('Fourth write\n', 1000);
      writeData('Fifth write\n', 3000);
      
    } catch (err) {
      if (err.code === 'ENOTSUP' || err.code === 'EPERM') {
        console.log('FIFOs not supported, skipping test');
        // FIFOs not supported, skip.
        done();
      } else {
        done(err);
      }
    }

  });

}); 
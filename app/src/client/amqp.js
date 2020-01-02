'use strict';

const Promise = require('bluebird');
const logger = require('../logger');
const amqp = require('amqplib');
const { isFatalError } = require('amqplib/lib/connection');
const { EventEmitter } = require('events');

class AmqpClient {
  /**
   * @param {string} host
   * @param {string|number} port
   * @param {string} username
   * @param {string} password
   * @param {number} heartbeatInSeconds
   * @param {boolean} requeue
   */
  constructor(host, port, username, password, heartbeatInSeconds, requeue) {
    this.host = this.buildHost(host, port, username, password);
    this.pollingListeners = [];
    this.connectionBackoff = 10;
    this.retryFailures = 0;
    this.requeue = requeue;
    this.messageProcessed = new EventEmitter();
    this.heartbeatInSeconds = heartbeatInSeconds || 10;
  }

  /**
   * @return {Promise<AmqpClient>}
   */
  init() {
    logger.debug('Trying to connect to AMQP broker');

    return new Promise((resolve, reject) => {
      amqp.connect(`amqp://${this.host}?heartbeat=${this.heartbeatInSeconds}`).then(connection => {
        process.once('SIGINT', () => connection && connection.close());
        this._connection = connection;

        connection.once('error', err => {
          this._connection = null;
          this._lastConnectionError = err;

          logger.warn('Connection error with broker. Attempting reconnect', err);
          this.reconnect();
        });

        connection.once('close', reason => {
          if (isFatalError(reason) || (reason.message && reason.message.indexOf('broker forced connection closure') > -1)) {
            this._connection.emit('error', reason);
          }
        });
    
        connection.createChannel().then(channel => {
          this.channel = channel;
          this.retryFailures = 0;
          this.connectionBackoff = 10;
          this._lastConnectionError = null;
          resolve(this);
        }).catch(reject);
      })
      .catch(reject);
    });
  }

  stop() {
    if (this._connection) {
      this._connection.close();
    }
  }

  /**
   * Ensures that queues exists and attaches new listeners
   * 
   * @param {{name: string, interval: number}[]} queues list of queue names and interval to check for messages
   * @param {(queue, message) => {}} callable
   * @param {(queue) => {}} processingState
   */
  updateListeners(queues, callable, processingState) {
    logger.info('Ensuring queues exist', {queues});
    this.pollingListeners.forEach(clearInterval);
    this.pollingListeners.length = 0;

    const assertQueues = queues.map(queue => 
      this.channel.assertQueue(queue.name, { durable: true }));

    Promise.all(assertQueues)
      .then((results) => queues.forEach(queue => {
        this.fetchMessages(queue.name, callable, processingState);
        this.pollingListeners.push(
          setInterval(() => this.fetchMessages(queue.name, callable, processingState), queue.interval)
        );
      }))
      .catch(err => {
        logger.error('Error updating amqp listeners', err);
        process.exit(1);
      })
  }

  /**
   * Checks queue for new messages and calls {@code consumeMessage} if max parallelism is not reached
   * 
   * @param {string} queue name of the queue to ask for a message
   * @param {(queue, message) => {}} callable
   * @param {(queue) => {}} processingState
   */
  fetchMessages(queue, callable, processingState) {
    if (logger.isDebugEnabled()) {
      logger.debug('Checking for new messages in queue', {queue});
    }

    processingState(queue).then(state => {
      if (state.busy) {
        logger.info('Max parallelism reached. Queue busy', { queue });
      } else {
        this.channel.get(queue)
          .then(message => {
            if (message) {
              this.consumeMessage(queue, message, callable, processingState);
            } else if (logger.isDebugEnabled()) {
              logger.debug('No new messages in queue', { queue });
            }
          })
          .catch(error => logger.error('Could not get message from queue', { queue, error }));
        }
      })
      // processState is expected to always resolve (with local fallback)
      .catch(err => logger.error('Unhandled error during processing state check', err));
  }

  /**
   * Dispatches a message to the callable and acknowledges the message if {@code callable} succeeds
   * Rejects a message when the {@code callable} fails
   * 
   * @param {string} queue name of the queue the message comes from
   * @param message amqp message object
   * @param {(queue, message) => {}} callable invoked on message, must return a promise to ensure successfull completion
   * @param {(queue) => {}} processingState
   */
  consumeMessage(queue, message, callable, processingState) {
    callable(queue, message)
      .then(data => {
        this.channel.ack(message);
        this.messageProcessed.emit(queue, {success: true, queue });
        logger.info('Successfully dispatched message from queue', { data });

        // fetch next message if there is any and queue is not busy
        this.fetchMessages(queue, callable, processingState);
      })
      .catch(err => {
        logger.error('Error while trying to dispatch message from queue ' + queue, err);
        this.channel.nack(message, false, this.requeue);
        this.messageProcessed.emit(queue, {success: false, error: err, queue});
      });
  }

  reconnect() {
    this.init()
      .then(() => logger.info('Successfully reconnected to broker'))
      .catch(err => {
        this.retryFailures++;

        if (this.retryFailures < 5) {
          logger.warn('Could not reconnect to broker. Retrying in ' + this.connectionBackoff + ' seconds', err);

          setTimeout(() => this.reconnect(), this.connectionBackoff * 1000);
          this.connectionBackoff = Math.ceil(this.connectionBackoff * (Math.random() * 2.5));
        } else {
          logger.error('Connection error not recovered after retries. Exiting', this._lastConnectionError, err);
          process.exit(1);
        }
      });
  }

  /**
   * creates the full uri for amqp broker
   * 
   * @param {string} host
   * @param {number|string} port
   * @param {string} username unencoded username
   * @param {string} password unencoded plain password
   */
  buildHost(host, port, username, password) {
    if (username && password) {
      return `${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
    } else {
      return `${host}:${port}`;
    }
  }
}

/**
 * @type {AmqpClient}
 */
module.exports = AmqpClient;

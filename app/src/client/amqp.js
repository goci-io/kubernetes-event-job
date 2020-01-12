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
    this.pollingListeners = [];
    this.requeue = requeue;
    this.messageProcessed = new EventEmitter();
    this.heartbeatInSeconds = heartbeatInSeconds || 10;
    this.host = this.buildHost(host, port, username, password);
  }

  /**
   * @param {boolean|{ca:string[], cert:string,key:string,password:string}} ssl optional falsy does not enable ssl
   * 
   * @return {Promise<AmqpClient>}
   */
  init(ssl) {
    logger.debug('Trying to connect to AMQP broker');
    const sslOpts = ssl ? this.buildSslOptions(ssl.ca, ssl.cert, ssl.key, ssl.passphrase) : {};
    const protocol = ssl ? 'amqps' : 'amqp';

    return amqp.connect(`${protocol}://${this.host}?heartbeat=${this.heartbeatInSeconds}`, sslOpts)
      .then(async connection => {
        process.once('SIGINT', () => this.stop());
        this._connection = connection;
        this._closed = false;

        connection.once('close', reason => {  
          this._closed = true;

          if (isFatalError(reason) || (reason.message && reason.message.indexOf('broker forced connection closure') > -1)) {
            this.stop(reason);
          }
        });
    
        this.channel = await connection.createChannel();
        return this.channel;
      });
  }

  /**
   * Stops the connection to allow new connections and sets the last error occurred if provided.
   * The channel will not be explizitly flushed to allow further operations to be done through the existing channel.
   * As the connection will be closed we expect message receives and sends to fail and error handling to be in place.
   * 
   * @param {Error|null} withError 
   */
  stop(withError) {
    if (withError) {
      logger.error('Connection failure to broker with error', { error: withError });
      process.exit(1);
    } else {
      logger.info('Closing connection to broker gracefully...');
    }

    if (!this._closed) {
      this._connection.close()
        .then(() => logger.info('Connection to broker closed successfully'))
        .catch(e => logger.warn('Connection to broker may already be closed', { error: e }));
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
      .catch(err => this.unableToRecoverDuringRuntime(err));
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
        if (logger.isDebugEnabled()) {
          logger.debug('Max parallelism reached. Queue busy', { queue });
        }
      } else {
        this.channel.get(queue)
          .then(message => {
            if (message) {
              this.consumeMessage(queue, message, callable, processingState);
            } else {
              logger.info('No new messages in queue', { queue });
            }
          })
          .catch(error => logger.error('Could not get message from queue', { queue, error }));
        }
      })
      // processState is expected to always resolve (with local fallback)
      .catch(err => logger.error('Unhandled error during processing state check', { error: err }));
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
        logger.error('Error while trying to dispatch message from queue ' + queue, { error: err });
        this.channel.nack(message, false, this.requeue);
        this.messageProcessed.emit(queue, {success: false, error: err, queue});
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

  /**
   * Reads files from /var/ssl/ and creates amqp ssl options
   * 
   * @param {string} caChain list of files in /var/ssl/*.pem, divided by ,  
   * @param {string} certFile cert file name
   * @param {string} keyFile key file name
   * @param {string|null} passphrase passphrase for key file
   */
  buildSslOptions(caChain, certFile, keyFile, passphrase) {
    const fs = require('fs');
    const ca = caChain.split(',').map(ca => fs.readFileSync(`/var/ssl/${ca}.pem`));

    return {
      ca,
      passphrase,
      key: fs.readFileSync(`/var/ssl/${keyFile}.pem`),
      cert: fs.readFileSync(`/var/ssl/${certFile}.pem`),
    };
  }
}

/**
 * @type {AmqpClient}
 */
module.exports = AmqpClient;

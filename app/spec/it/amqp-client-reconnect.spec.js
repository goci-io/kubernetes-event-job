'use strict';

const { GenericContainer, Wait } = require("testcontainers");
const AmqpClient = require('../../src/client/amqp');

describe('AmqpClientReconnectIT', () => {
    const containers = [];

    afterEach(async () => {
        await Promise.all(containers.map(c => c.stop()));
        containers.length = 0;
    });

    it('should successfully reconnect', async done => {
        const [ failingInstance, newInstance ] = await Promise.all([
            new GenericContainer('rabbitmq', '3.8-alpine')
                .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
                .withExposedPorts(5672)
                .start(),
            new GenericContainer('rabbitmq', '3.8-alpine')
                .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
                .withExposedPorts(5672)
                .start(),      
        ]);

        const amqpClient = new AmqpClient('127.0.0.1', failingInstance.getMappedPort(5672), 'guest', 'guest', 5);

        await amqpClient.init();
        spyOn(amqpClient, 'reconnect').and.callThrough();

        // wait for heartbeat to fail
        const connectionErr = new Promise(resolve => amqpClient._connection.once('error', resolve))
        amqpClient.connectionBackoff = 2;

        await failingInstance.stop();
        await connectionErr;

        containers.push(newInstance);
        amqpClient.host = amqpClient.buildHost('127.0.0.1', newInstance.getMappedPort(5672), 'guest', 'guest');

        // wait for next retry
        // backoff for 3rd retry is too high, successful reconnect
        setTimeout(() => {
            expect(amqpClient.reconnect).toHaveBeenCalledTimes(2);
            expect(amqpClient.retryFailures).toBe(0);
            expect(amqpClient._connection).not.toBeNull();
            amqpClient.stop();
            done();
        }, 3500);
    }, 40000);

    it('should exit application when backoff limit is reached', async done => {
        const instance = await new GenericContainer('rabbitmq', '3.8-alpine')
            .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
            .withExposedPorts(5672)
            .start();

        const amqpClient = new AmqpClient('127.0.0.1', instance.getMappedPort(5672), 'guest', 'guest', 5);

        await amqpClient.init();
        spyOn(amqpClient, 'reconnect').and.callThrough();
        spyOn(process, 'exit').and.callFake(() => {});

        // wait for heartbeat to fail
        const connectionErr = new Promise(resolve => amqpClient._connection.once('error', resolve))
        amqpClient.connectionBackoff = 1;

        await instance.stop();
        await connectionErr;

        setTimeout(() => {
            expect(process.exit).toHaveBeenCalledTimes(1);
            expect(amqpClient.reconnect).toHaveBeenCalledTimes(5);
            done();
        }, 3000);
    }, 30000);

});

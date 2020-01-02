'use strict';

const crypto = require('crypto');
const k8sDelegate = require('@kubernetes/client-node');
const KubeConfigMock = require('../impl/kube-api');
const KubernetesClient = require('../../src/client/k8s');
const AmqpClient = require('../../src/client/amqp');
const MessageController = require('../../src/controller');
const { GenericContainer, Wait } = require("testcontainers");
const delegate = {
    KubeConfig: KubeConfigMock,
    BatchV1Api: k8sDelegate.BatchV1Api,
    CoreV1Api: k8sDelegate.CoreV1Api,
};

describe('FromMessageToJobIT', () => {
    let brokerContainer, amqpClient, k8sClient, controller;

    const sendMessage = (queue, message) =>
        amqpClient.channel.sendToQueue(queue, Buffer.from(message), { persistent: false, expiration: 60000 });
    
    beforeAll(async () => {
        brokerContainer = await new GenericContainer('rabbitmq', '3.8-alpine')
            .withWaitStrategy(Wait.forLogMessage('Server startup complete'))
            .withExposedPorts(5672)
            .start();

        k8sClient = new KubernetesClient('ctx', delegate);
        amqpClient = new AmqpClient('127.0.0.1', brokerContainer.getMappedPort(5672), 'guest', 'guest');
        controller = new MessageController(k8sClient, amqpClient, 'config', false, 'deploy', 'default.registry');
        
        await Promise.all([k8sClient.init(), amqpClient.init()]);
        controller.start();

        // await reload event and updated listeners, see ../impl/api-response.json
        await new Promise(resolve => setTimeout(resolve, 200));
    }, 30000);

    afterAll(async () => {
        await brokerContainer.stop();
        controller.stop();
    });

    it('should create k8s job from message', done => {
        spyOn(k8sClient.batchApi, 'createNamespacedJob').and.callThrough();
        spyOn(k8sClient.coreApi, 'createNamespacedSecret').and.callThrough();

        const testMessage = '{"test":"abc"}';
        const jobName = 'testName';
        const expectedMetadata = {
            name: jasmine.any(String),
            namespace: 'ctx',
            labels: {
                'app.kubernetes.io/component': 'job',
                'app.kubernetes.io/managed-by': 'goci-kubernetes-event-job',
                'app.kubernetes.io/name': 'test-queue-1-processor',
                'app.kubernetes.io/version': 'latest',
                'app.kubernetes.io/part-of': 'ctx',
                jobgroup: 'kubernetes-event-jobs',
                jobitem: jobName,
            },
        };

        amqpClient.messageProcessed.once('test-queue-1', data => {
            expect(data.success).toBe(true);
            expect(data.queue).toBe('test-queue-1');
            expect(k8sClient.batchApi.createNamespacedJob).toHaveBeenCalledTimes(1);
            expect(k8sClient.coreApi.createNamespacedSecret).toHaveBeenCalledTimes(1);
            expect(k8sClient.coreApi.createNamespacedSecret).toHaveBeenCalledWith('ctx', jasmine.objectContaining({
                metadata: {
                    name: jasmine.any(String),
                    namespace: 'ctx',
                },
                data: {
                    TARGET: jasmine.any(String),
                    ISSUER: k8sClient.encodedIssuer,
                    MESSAGE: Buffer.from(testMessage).toString('base64'),
                    CHECKSUM: crypto.createHash('sha1').update('ctx:testName:' + testMessage).digest('base64'),
                },
            }));
            expect(k8sClient.batchApi.createNamespacedJob).toHaveBeenCalledWith('ctx', {
                metadata: expectedMetadata,
                spec: {
                    parallelism: 1,
                    backoffLimit: 5,
                    ttlSecondsAfterFinished: 21600,
                    activeDeadlineSeconds: 900,
                    template: {
                        metadata: expectedMetadata,
                        spec: {
                            restartPolicy: 'OnFailure',
                            containers: [
                                {
                                    name: 'processor',
                                    image: 'default.registry/test-runner:latest',
                                    envFrom: [ { secretRef: { name: jasmine.any(String) }}],
                                    env: [],
                                    resources: {
                                        requests: {
                                            cpu: '10m',
                                            memory: '56Mi',
                                        },
                                        limits: {
                                            cpu: '25m',
                                            memory: '96Mi',
                                        },
                                    },
                                },
                            ],
                        },
                    },
                },
            });
            
            done();
        });

        sendMessage('test-queue-1', testMessage);
    }, 10000);

    it('should increase current count by each message if current running jobs cannot be determined', async () => {
        spyOn(k8sClient.batchApi, 'listNamespacedJob').and.throwError('error listing jobs');
        spyOn(k8sClient.batchApi, 'createNamespacedJob').and.callThrough();
        spyOn(k8sClient.coreApi, 'createNamespacedSecret').and.callThrough();
        const testMessage = '{"test":"abc"}';

        expect(controller.config['test-queue-2'].interval).toBe(1000);
        
        await Promise.all([
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            sendMessage('test-queue-2', testMessage),
            // wait for controller to poll messages (interval 1sec)
            new Promise((resolve) => setTimeout(resolve, 15000)),
        ]);

        const queueState = await controller.getProcessingState('test-queue-2');

        expect(queueState.busy).toBe(true);
        expect(queueState.state).toBe('old');
        expect(queueState.active).toBe(10);
        expect(k8sClient.batchApi.createNamespacedJob).toHaveBeenCalledTimes(10);
    }, 30000);

});

'use strict';

const yaml = require('yaml');
const JobConfig = require('../src/job-config');
const MessageController = require('../src/controller');

describe('MessageController', () => {

    it('should reload configs on start and update listeners with new config', done => {
        const exampleConfig = {
            queue1: `image: job-image\njobName: test\ninterval: 30`,
        };

        const k8sClient = { getConfigMap: () => Promise.resolve({ body: { data: exampleConfig }})};
        const amqpClient = { updateListeners: () => {}};
        spyOn(amqpClient, 'updateListeners');

        const configReloadListener = { on: () => {} };
        spyOn(configReloadListener, 'on');

        const controller = new MessageController(k8sClient, amqpClient);
        controller.start();
        controller.configReload.on('reload', configReloadListener.on);

        // wait for reload event
        setTimeout(() => {
            expect(configReloadListener.on).toHaveBeenCalledTimes(1);
            expect(amqpClient.updateListeners).toHaveBeenCalledTimes(1);
            expect(amqpClient.updateListeners).toHaveBeenCalledWith([{ name: 'queue1', interval: 30000 }], jasmine.any(Function), jasmine.any(Function));
            expect(controller.config.queue1.image).toBe('job-image:latest');
            expect(controller.config.queue1.jobName).toBe('test');
            done();
        });
    });

    it('should not update listeners if config did not change', done => {
        const job = {
            image: 'my-job-runner',
            imageVersion: '1.2.3',
            timeout: 500,
            environment: [
                { name: 'MY_ENV', value: 'env' },
            ],
        };

        const data = { test: yaml.stringify(job) };
        const k8sClient = {
            getConfigMap: () => new Promise(resolve => resolve({ body: { data }})),
        };

        const amqpClient = { updateListeners: () => {} };

        const controller = new MessageController(k8sClient, amqpClient);
        controller.start();

        controller.configReload.once('reload', () => {
            spyOn(amqpClient, 'updateListeners');
            amqpClient.updateListeners.calls.reset();

            // nothing should change
            controller.setConfig(data);

            // trigger change
            job.imageVersion = '3.2.1';
            controller.setConfig({
                test: yaml.stringify(job),
            });

            setTimeout(() => {
                expect(amqpClient.updateListeners).toHaveBeenCalledTimes(1);
                done();
            });
        });
    });

    it('should exit when initial config cannot be loaded and reload is not enabled', done => {
        spyOn(process, 'exit');

        const k8sClient = { 
            getConfigMap: () => new Promise((_, reject) => reject(new Error('error'))),
        };

        const controller = new MessageController(k8sClient, null, null, false);
        controller.start();

        setTimeout(() => {
            expect(process.exit).toHaveBeenCalledWith(1);
            done();
        });
    });

    describe('getProcessingState', () => {
        [
            [ 'not busy queue', 'fresh', false, 2 ],
            [ 'busy queue', 'fresh', true, 5 ],
        ].forEach(([name, state, busy, active]) => {
            it('should return state for not ' + name, done => {
                const k8sClient = { countActiveMessageJobs: () => new Promise(resolve => resolve(active)) };
                const controller = new MessageController(k8sClient);
                controller.config = {
                    queue: {
                        parallelism: 3
                    }
                };

                controller.getProcessingState('queue').then(result => {
                    expect(result.state).toBe(state);
                    expect(result.busy).toBe(busy);
                    done();
                });
            });
        });

        it('should return fallback local state', async () => {
            const k8sClient = { countActiveMessageJobs: () => new Promise((_, reject) => reject(new Error('error'))) };
            const controller = new MessageController(k8sClient);
            controller.config = {
                queue: {
                    parallelism: 3
                }
            };

            const call1 = await controller.getProcessingState('queue')
            expect(call1.active).toBe(0);
            expect(call1.busy).toBe(false);

            const call2 = await controller.getProcessingState('queue')
            expect(call2.active).toBe(1);
            expect(call2.busy).toBe(false);

            const call3 = await controller.getProcessingState('queue')
            expect(call3.active).toBe(2);
            expect(call3.busy).toBe(false);

            const call4 = await controller.getProcessingState('queue')
            expect(call4.active).toBe(3);
            expect(call4.busy).toBe(true);
        });

        it('should change to busy even after config reload', async () => {
            const k8sClient = { countActiveMessageJobs: () => new Promise(resolve => resolve(2)) };
            const controller = new MessageController(k8sClient);
            controller.config = {
                queue: {
                    parallelism: 3
                }
            };

            const result = await controller.getProcessingState('queue');
            expect(result.active).toBe(2);
            expect(result.busy).toBe(false);

            k8sClient.countActiveMessageJobs = () => new Promise((_, reject) => reject(new Error('error')));
            controller.setConfig({
                queue: `image: job-image\njobName: test\ninterval: 30\nparallelism: 2`,
                queue2: `image: job-image\njobName: test2\ninterval: 30`,
            });

            const errorCall1 = await controller.getProcessingState('queue')
            expect(errorCall1.active).toBe(2);
            expect(errorCall1.busy).toBe(true);

            const queue2Call = await controller.getProcessingState('queue2')
            expect(queue2Call.active).toBe(0);
            expect(queue2Call.busy).toBe(false);
        });

        it('should allow unlimited parallelism', async () => {
            const controller = new MessageController();
            controller.config = {
                queue: {
                    parallelism: 'unlimited',
                },
            };
            
            const stateChecks = [];
            for (let i = 0; i <  100; i++) stateChecks.push(controller.getProcessingState('queue'));
            const result = await Promise.all(stateChecks);

            expect(result.length).toBe(100);
            result.forEach(i => {
                expect(i.count).toBe(0);
                expect(i.busy).toBe(false);
                expect(i.state).toBe('unlimited');
            });
        });
    });

});

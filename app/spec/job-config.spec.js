'use strict';

const JobConfig = require('../src/job-config');

describe('JobConfig', () => {

    it('should return true for equal configs', () => {
        const job1 = new JobConfig('key1', {
            image: 'image1',
            queue: 'queue',
            jobName: 'name',
            serviceAccount: 'sa',
            labels: { cool: 'true' },
            resources: { requests: { memory: '128Mi' }},
            environment: [
                { name: 'key', value: 'value' },
            ]
        });

        const job2 = new JobConfig('key1', {
            image: 'image1',
            queue: 'queue',
            jobName: 'name',
            serviceAccount: 'sa',
            labels: { cool: 'true' },
            resources: { requests: { memory: '128Mi' }},
            environment: [
                { name: 'key', value: 'value' },
            ]
        });

        expect(job1.equals(job2)).toBe(true);
    });

    it('should use default configs', () => {
        const job = new JobConfig('queue', { jobName: 'job', image: 'image' }, 'default', 'registry');

        expect(job.alias).toBe('queue');
        expect(job.jobName).toBe('job');
        expect(job.labels.jobitem).toBe('job');
        expect(job.labels.jobgroup).toBe('kubernetes-event-jobs');
        expect(job.labels['app.kubernetes.io/name']).toBe('queue-processor');
        expect(job.image).toBe('registry/image:latest');
        expect(job.namespace).toBe('default');
        expect(job.interval).toBe(60000);
        expect(job.timeout).toBe(3600);
    });

    [
        ['queue', new JobConfig('key1', {}), new JobConfig('key2', {})],
        ['namespace', new JobConfig('key', {}, 'scope'), new JobConfig('key', {})],
        ['registry', new JobConfig('key', {}, null, 'registry'), new JobConfig('key', {})],
        ['image', new JobConfig('key', { image: 'a' }), new JobConfig('key', { image: 'b' })],
        ['jobName', new JobConfig('key', { jobName: 'a' }), new JobConfig('key', { jobName: 'b' })],
        ['resource limits', new JobConfig('key', { resources: { limits: { cpu: '2' }}}), new JobConfig('key', {})],
        ['resource requests', new JobConfig('key', { resources: { requests: { memory: '128Mi' }}}), new JobConfig('key', {})],
        ['environment', 
            new JobConfig('key', { environment: [{ name: 'a', value: 'a'}, { name: 'b', value: 'b' }]}), 
            new JobConfig('key', { environment: [{ name: 'a', value: 'a'}, { name: 'b', value: 'c'}]})],
    ].forEach(entry => {
        it(`should return false for different config on ${entry[0]}`, () => {
            expect(entry[1].equals(entry[2])).toBe(false);
        });
    });

});

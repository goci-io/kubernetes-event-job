
export DOCKER_REGISTRY ?= gocidocker

start:
	cd app && npm start

test:
	cd app && npm test

build:
	docker build -t kubernetes-event-job .

release:
	docker tag kubernetes-event-job $(DOCKER_REGISTRY)/kubernetes-event-job:$(VERSION)
	docker push $(DOCKER_REGISTRY)/kubernetes-event-job:$(VERSION)

deploy:

build-and-deploy: build release deploy

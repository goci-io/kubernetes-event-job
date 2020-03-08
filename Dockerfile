FROM node:12.16-alpine3.11

COPY app/src /opt/app/
COPY package*.json /opt/app/
WORKDIR /opt/app

ENV NODE_ENV "production"
RUN npm i

ENTRYPOINT [ "npm" ]
CMD [ "start" ]

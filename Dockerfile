FROM node:12.13-alpine

COPY app/src /opt/app/
COPY package*.json /opt/app/
WORKDIR /opt/app

ENV NODE_ENV "production"
RUN npm i

ENTRYPOINT [ "npm" ]
CMD [ "start" ]

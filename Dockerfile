FROM node:12.13-alpine

COPY app /opt/app/
WORKDIR /opt/app

ENV NODE_ENV "production"
RUN npm i

ENTRYPOINT [ "npm" ]
CMD [ "start" ]

FROM alpine:3.12

ARG TARGETARCH=amd64

RUN echo $'\
@edge http://dl-cdn.alpinelinux.org/alpine/edge/main\n\
@edge http://dl-cdn.alpinelinux.org/alpine/edge/testing\n\
@edge http://dl-cdn.alpinelinux.org/alpine/edge/community' >> /etc/apk/repositories

RUN apk add --no-cache \
      python3 py3-pip py3-setuptools py3-wheel \
      py3-virtualenv \
      py3-pillow \
      py3-aiohttp \
      py3-magic \
      py3-ruamel.yaml \
      py3-commonmark@edge \
      # Other dependencies
      ca-certificates \
      su-exec \
      # encryption
      olm-dev \
      py3-cffi \
	  py3-pycryptodome \
      py3-unpaddedbase64 \
      py3-future \
      bash \
      curl \
      jq && \
  curl -sLo yq https://github.com/mikefarah/yq/releases/download/3.3.2/yq_linux_${TARGETARCH} && \
  chmod +x yq && mv yq /usr/bin/yq


COPY requirements.txt /opt/matrix-appservice-line/requirements.txt
COPY optional-requirements.txt /opt/matrix-appservice-line/optional-requirements.txt
WORKDIR /opt/matrix-appservice-line
RUN apk add --virtual .build-deps python3-dev libffi-dev build-base \
 && pip3 install -r requirements.txt -r optional-requirements.txt \
 && apk del .build-deps

COPY . /opt/matrix-appservice-line
RUN apk add git && pip3 install .[e2be] && apk del git \
  # This doesn't make the image smaller, but it's needed so that the `version` command works properly
  && cp matrix_appservice_line/example-config.yaml . && rm -rf matrix_appservice_line

VOLUME /data
ENV UID=1337 GID=1337

CMD ["/opt/matrix-appservice-line/docker-run.sh"]

FROM ubuntu:24.04
ARG NODE_VERSION=24.22.1
ARG REA_VERSION=6.8.0
ARG GHIDRA_VERSION=12.1.4
ARG GHIDRA_DATE=20260921
ARG GHIDRA_SHA256=ddac49f903da9d5bac833e5cc79395098b9c33cfd3279be5f31bd00387d2d4db
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl xz-utils unzip openjdk-21-jdk-headless procps gcc libc6-dev python3 git tcpdump && rm -rf /var/lib/apt/lists/*
RUN curl --fail --location --retry 3 --output /tmp/node.tar.xz "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    && curl --fail --location --retry 3 --output /tmp/SHASUMS256.txt "https://nodejs.org/dist/v${NODE_VERSION}/SHASUMS256.txt" \
    && cd /tmp && sha256sum node.tar.xz | cut -d ' ' -f 1 > actual.sha \
    && awk -v f="node-v${NODE_VERSION}-linux-x64.tar.xz" '$2 == f {print $1}' SHASUMS256.txt > expected.sha \
    && test -s expected.sha && cmp actual.sha expected.sha \
    && tar -xJf node.tar.xz --strip-components=1 -C /usr/local && rm /tmp/node.tar.xz /tmp/SHASUMS256.txt /tmp/actual.sha /tmp/expected.sha
RUN npm install --global "rea-agents@${REA_VERSION}"
RUN curl --fail --location --retry 3 --output /tmp/ghidra.zip "https://github.com/NationalSecurityAgency/ghidra/releases/download/Ghidra_${GHIDRA_VERSION}_build/ghidra_${GHIDRA_VERSION}_PUBLIC_${GHIDRA_DATE}.zip" \
    && echo "${GHIDRA_SHA256}  /tmp/ghidra.zip" | sha256sum --check - \
    && unzip -q /tmp/ghidra.zip -d /opt && rm /tmp/ghidra.zip
ENV GHIDRA_INSTALL_DIR=/opt/ghidra_12.1.4_PUBLIC
ENV NO_COLOR=1
WORKDIR /work
CMD ["rea", "doctor", "--provider", "ghidra", "--json"]

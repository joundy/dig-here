# Toolbox for the NEAR contract and testnet work. Nothing here is installed on the host.
# Build and run through docker/near. Prebuilt binaries only, each checked against its published sha256.

# The rust image is rustup-managed, so wasm32-unknown-unknown (what docs.near.org asks for) adds cleanly.
# near-sdk needs Rust 1.95 or newer. The near-sandbox binary needs glibc 2.39, so trixie and not bookworm.
FROM rust:1.99-slim-trixie

ARG NEAR_CLI_VERSION=0.30.1
ARG CARGO_NEAR_VERSION=0.22.0
ARG NEAR_SANDBOX_VERSION=2.14.0
ARG NODE_VERSION=24.22.2
# Match the host user, so files written to the mounted project and the named volumes stay theirs.
ARG USER_ID=1000
ARG GROUP_ID=1000

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates curl git jq make pkg-config xz-utils libudev1 libssl-dev \
 && rm -rf /var/lib/apt/lists/*

RUN rustup target add wasm32-unknown-unknown \
 && rustup component add rustfmt clippy

RUN set -eu; cd /tmp; \
    fetch_checked() { \
      curl -fsSLO "$1/$2"; \
      curl -fsSL "$1/$2.sha256" | awk -v f="$2" '{print $1"  "f}' | sha256sum -c -; \
    }; \
    fetch_checked "https://github.com/near/near-cli-rs/releases/download/v${NEAR_CLI_VERSION}" near-cli-rs-x86_64-unknown-linux-gnu.tar.gz; \
    tar xzf near-cli-rs-x86_64-unknown-linux-gnu.tar.gz --strip-components=1 -C /usr/local/bin near-cli-rs-x86_64-unknown-linux-gnu/near; \
    fetch_checked "https://github.com/near/cargo-near/releases/download/cargo-near-v${CARGO_NEAR_VERSION}" cargo-near-x86_64-unknown-linux-gnu.tar.gz; \
    tar xzf cargo-near-x86_64-unknown-linux-gnu.tar.gz --strip-components=1 -C /usr/local/bin cargo-near-x86_64-unknown-linux-gnu/cargo-near; \
    rm -f /tmp/*.tar.gz

# No sha256 is published for the sandbox. This is the URL the near-sandbox crate itself downloads from.
RUN set -eu; \
    curl -fsSL "https://s3-us-west-1.amazonaws.com/build.nearprotocol.com/nearcore/Linux-x86_64/${NEAR_SANDBOX_VERSION}/near-sandbox.tar.gz" \
      | tar xzO --wildcards '*near-sandbox' > /usr/local/bin/near-sandbox; \
    chmod 755 /usr/local/bin/near-sandbox
# Stops the near-sandbox crate downloading its own copy in tests.
ENV NEAR_SANDBOX_BIN_PATH=/usr/local/bin/near-sandbox

RUN set -eu; cd /tmp; \
    base="https://nodejs.org/dist/v${NODE_VERSION}"; f="node-v${NODE_VERSION}-linux-x64.tar.xz"; \
    curl -fsSLO "$base/$f"; \
    curl -fsSL "$base/SHASUMS256.txt" | grep " $f\$" | sha256sum -c -; \
    tar xJf "$f" --strip-components=1 -C /usr/local --exclude='*.md' --exclude=LICENSE; \
    rm -f "$f"

# Named volumes copy the owner of the directory they first mount over, so create these before use.
RUN groupadd -g "${GROUP_ID}" near \
 && useradd -m -u "${USER_ID}" -g "${GROUP_ID}" near \
 && mkdir -p /home/near/.near-credentials /home/near/.config /usr/local/cargo/registry /usr/local/cargo/git /work \
 && chown -R near:near /home/near /usr/local/cargo/registry /usr/local/cargo/git /work

USER near
WORKDIR /work

# `cargo near new` makes a first commit and fails without a committer identity.
RUN git config --global user.name near-tools \
 && git config --global user.email near-tools@localhost

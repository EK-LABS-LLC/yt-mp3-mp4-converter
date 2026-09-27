# Multi-stage build for YouTube to MP3/MP4 Converter
# Supports both standard Docker and Raspberry Pi (ARM) architectures

FROM oven/bun:1.4.2 AS base
WORKDIR /app

# Copy package files
COPY package.json bun.lock ./

# Install dependencies
RUN bun install --frozen-lockfile

# Copy source code and public files
COPY src ./src
COPY public ./public
COPY tsconfig.json ./

# Build the TypeScript project
RUN bun build src/index.ts --target=bun --outdir ./dist

# Production stage
FROM oven/bun:1.4.2 AS production

WORKDIR /app

# Install runtime dependencies and the tools needed to build whisper-cli from
# source, then drop the build tools and source tree so the image stays lean.
# Building from source keeps the image working on both amd64 and arm64.
RUN apt-get update && apt-get install -y \
    ffmpeg \
    python3 \
    python3-venv \
    git \
    cmake \
    build-essential \
    curl \
    && git clone --depth 1 https://github.com/ggml-org/whisper.cpp /tmp/whisper.cpp \
    && cd /tmp/whisper.cpp \
    && cmake -B build -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DCMAKE_BUILD_TYPE=Release \
    && cmake --build build --config Release -j2 --target whisper-cli \
    && install -m 0755 build/bin/whisper-cli /usr/local/bin/whisper-cli \
    && cd / \
    && rm -rf /tmp/whisper.cpp \
    && apt-get purge -y git cmake build-essential \
    && apt-get autoremove -y \
    && rm -rf /var/lib/apt/lists/*

# Keep yt-dlp isolated from Debian's externally managed Python environment.
RUN python3 -m venv /opt/yt-dlp \
    && /opt/yt-dlp/bin/pip install --no-cache-dir yt-dlp

# Demucs uses Python 3.11 even when the base image upgrades system Python.
COPY --from=ghcr.io/astral-sh/uv:0.8.22 /uv /usr/local/bin/uv
ENV UV_PYTHON_INSTALL_DIR=/opt/python
RUN uv venv --python 3.11 /opt/demucs \
    && uv pip install --python /opt/demucs/bin/python --no-cache 'torch==2.5.1' 'torchaudio==2.5.1' --index-url https://download.pytorch.org/whl/cpu \
    && uv pip install --python /opt/demucs/bin/python --no-cache 'demucs==4.0.1' 'numpy<2' 'soundfile==0.13.1'
ENV DEMUCS_PATH=/opt/demucs/bin/demucs
ENV TORCH_HOME=/models/torch
RUN /opt/demucs/bin/python -c 'from demucs.pretrained import get_model; get_model("htdemucs")'

# Bake the model into the image so transcription is ready at startup.
RUN mkdir -p /models \
    && (curl -fL --retry 5 --retry-delay 5 --retry-all-errors \
        https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
        -o /models/ggml-base.en.bin.tmp \
        && mv /models/ggml-base.en.bin.tmp /models/ggml-base.en.bin) \
    && test -s /models/ggml-base.en.bin

# Create download directory with proper permissions
RUN mkdir -p /tmp/yt-converter-downloads

# Copy built files from base stage
COPY --from=base /app/dist ./dist
COPY --from=base /app/node_modules ./node_modules
COPY --from=base /app/public ./public
COPY --from=base /app/package.json ./

# Set environment variables
ENV PORT=3000
ENV DOWNLOAD_DIR=/tmp/yt-converter-downloads
ENV NODE_ENV=production
ENV PATH="/opt/yt-dlp/bin:${PATH}"
ENV WHISPER_MODEL_PATH=/models/ggml-base.en.bin

# Expose the application port
EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -fsS http://127.0.0.1:3000/health >/dev/null \
      && yt-dlp --version >/dev/null \
      && ffmpeg -version >/dev/null 2>&1 \
      && whisper-cli --help >/dev/null 2>&1 \
      && test -s /models/ggml-base.en.bin

# Run the application
STOPSIGNAL SIGTERM
CMD ["bun", "dist/index.js"]

FROM python:3.12-slim

WORKDIR /app

# Ensure unbuffered python output for clean container logs
ENV PYTHONUNBUFFERED=1
ENV PORT=8080

# Copy application files
COPY routing.py server.py ./
COPY data/ ./data/
COPY static/ ./static/

EXPOSE 8080

HEALTHCHECK --interval=15s --timeout=3s --start-period=5s --retries=3 \
  CMD python3 -c "import urllib.request; urllib.request.urlopen('http://localhost:8080/api/health')" || exit 1

ENTRYPOINT ["python3", "server.py"]
CMD ["8080"]

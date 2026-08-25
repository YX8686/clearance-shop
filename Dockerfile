FROM node:18-alpine
WORKDIR /app
COPY . .
# 云端运行时由平台注入 PORT；OPEN=0 关闭容器内自动开浏览器
ENV OPEN=0
EXPOSE 4100
CMD ["node", "server.js"]

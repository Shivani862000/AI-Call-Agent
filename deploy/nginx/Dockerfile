FROM nginx:1.27-alpine

RUN rm -f /etc/nginx/conf.d/default.conf

COPY deploy/nginx/feedback-agent.conf /etc/nginx/templates/feedback-agent.conf.template
COPY deploy/nginx/20-render-template.sh /docker-entrypoint.d/20-render-template.sh

RUN chmod +x /docker-entrypoint.d/20-render-template.sh

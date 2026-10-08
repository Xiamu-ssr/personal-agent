# Personal Agent cloud body (App + devices). Auth is a bearer token checked by the service.
location = /agent { return 308 /agent/; }
location ^~ /agent/ {
    proxy_pass http://127.0.0.1:4400/;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
    client_max_body_size 20m;
}

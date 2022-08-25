# balena-rsyslog
A containerized logging solution for exporting balena service logs, using `rsyslog`.

## Development
### SERVICE_ID / IMAGE_ID service vars
To acquire and set SERVICE_ID and IMAGE_ID service vars:

- Run the following from a host OS terminal to get `serviceId` and `imageId` key-value pairs. Make sure they are for the current `logger` service. The best way to make sure `serviceId` / `imageId` are accurate is to wait for current release to equal target release.
```
balena exec -it balena_supervisor node -e "sqlite3=require('sqlite3'); db = new sqlite3.Database('/data/database.sqlite'); db.all('select * from image',console.log)"
```

- Go to Device Varibles and set SERVICE_ID and IMAGE_ID accordingly for the `rsyslog` service.


### Named pipe
Verify working on dev machine with `echo 'test' | systemd-cat` (if running an OS with systemd).

1715006
5319276
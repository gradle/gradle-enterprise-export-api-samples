# Export API Javascript Example

In this JavaScript example, build durations are calculated and written out to the JavaScript console.

## Setup

To run this sample:

1. Install [node.js].
2. Run `npm install` within this directory.

#### Authorisation
3. Create a Gradle Enterprise user with the `Export API` role as described in the [Export API Access Control] documentation.
4. Set two environment variables locally: `EXPORT_API_USER` `EXPORT_API_PASSWORD` to match the newly created Export API user credentials.

#### Running
5. Run `npm start my-company.gradle.com` replacing `my-company.gradle.com` with your Gradle Enterprise server URL.

Now start publishing builds to your Gradle Enterprise instance and watch their build durations get written to the console.

#### Integrate the sample in an HTML page

If using the script in an HTML page instead of a Node application, remove the first line of [index.js]:

```const EventSourcePolyfill = require('eventsource');```.

And ensure the `EventSourcePolyfill` module is loaded in the page before running the example script by adding:

```
<script type="text/javascript" src="https://unpkg.com/@heroku/eventsource@1.0.7/example/eventsource-polyfill.js"></script>
```

to the `<head>` of the HTML page. 

[index.js]: index.js
[node.js]: https://nodejs.org/
[Export API Access Control]: https://docs.gradle.com/enterprise/export-api/#access_control
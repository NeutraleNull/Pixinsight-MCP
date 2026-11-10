// Sent right after a script of the older engine that was started with hook.js. That engine
// keeps its scope from one script to the next, so what the hook changed is put back here, whatever
// became of the script. No engine directive: this has to run where the hook ran.
if ( typeof __mcpUnhookDialogs === "function" )
   __mcpUnhookDialogs();

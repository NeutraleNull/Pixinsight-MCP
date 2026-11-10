#engine v8
// For when a script was announced with begin_log.js and the job behind it could not be sent:
// nothing else would end that log, and the console of the user would go on writing into a file.
try
{
   console.endLog();
}
catch ( error )
{
   // No log was running.
}

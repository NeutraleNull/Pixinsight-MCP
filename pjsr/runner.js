#engine v8
// Fixed entry point for every job: PixInsight -x=<slot>:runner.js,<jobDir>
//
// Whatever an operation does, this script must leave a result.json behind, because that file
// is the only way the server learns how a job ended. A syntax error in this file would leave
// nothing at all, which is why everything else is loaded separately with eval.
( function()
{
   const jobDir = Runtime.jsArguments[0];

   function writeAtomic( name, text )
   {
      const path = jobDir + "/" + name;
      File.writeTextFile( path + ".tmp", text );
      File.move( path + ".tmp", path );
   }

   // BigInt is not JSON-serializable, and some process parameters are typed arrays.
   function toJson( value )
   {
      return JSON.stringify( value, ( key, v ) =>
         (typeof v == "bigint") ? v.toString() : (ArrayBuffer.isView( v ) ? Array.from( v ) : v) );
   }

   function fail( kind, message )
   {
      const error = new Error( message );
      error.kind = kind;
      throw error;
   }

   function classify( error )
   {
      if ( error.kind )
         return error.kind;
      return /Process aborted/.test( "" + error.message ) ? "aborted" : "script_error";
   }

   // The server keeps writing the time into this file while it waits for the job. PixInsight can
   // get to a job much later, after a dialog was closed, and by then the server may have given up
   // on it or be gone. Nobody would see what such a job does, so it must not run.
   const MAX_SILENCE_MS = 15000;
   function isAwaited()
   {
      try
      {
         return Date.now() - Number( File.readTextFile( jobDir + "/awaited" ) ) < MAX_SILENCE_MS;
      }
      catch ( error )
      {
         return false;
      }
   }

   const result = { ok: false };
   const ctx = { jobDir, fail, toJson };
   try
   {
      // In this order, so that the server can tell for sure: it withdraws a job first and then
      // looks for this file. If the file is not there by then, the check below sees the withdrawal.
      writeAtomic( "started.json", toJson( { at: Date.now(), instance: CoreApplication.instance } ) );
      if ( !isAwaited() )
         fail( "withdrawn", "The server no longer waits for this job, so it was not run." );
      console.beginLog( jobDir + "/console.log" );
      const job = JSON.parse( File.readTextFile( jobDir + "/job.json" ) );
      ( 0, eval )( File.readTextFile( job.opsDir + "/../lib.js" ) )( ctx );
      const source = File.readTextFile( job.opsDir + "/" + job.op + ".js" );
      const op = ( 0, eval )( "(function( args, ctx ){\n" + source + "\n})" );
      result.value = op( job.args, ctx );
      result.ok = true;
   }
   catch ( error )
   {
      result.error = { kind: classify( error ), message: "" + (error.message || error) };
   }

   try
   {
      // Which images hold unsaved work, so that the server can say what a later crash lost.
      result.images = ctx.imageStates();
   }
   catch ( error )
   {
      // Not worth failing a job for.
   }

   try
   {
      console.endLog();
   }
   catch ( error )
   {
      // The log never began. The server reads what there is from console.log.
   }

   try
   {
      writeAtomic( "result.json", toJson( result ) );
   }
   catch ( error )
   {
      try
      {
         writeAtomic( "result.json", JSON.stringify( { ok: false, error: { kind: "unserializable_result", message: "" + error } } ) );
      }
      catch ( unwritable )
      {
         console.criticalln( "*** Could not write the result of a job to " + jobDir + ": " + unwritable );
      }
   }
} )();

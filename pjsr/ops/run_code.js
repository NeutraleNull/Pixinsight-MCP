// Code of the assistant's own. Only offered if the user has turned it on.
const MAX_RESULT_LENGTH = 60000;
const before = ctx.imageDetails();

// The code may have changed images before it failed, and an error must not hide that.
function withChanges( message )
{
   try
   {
      const { newViews, closedViews, changedViews } = ctx.changesSince( before );
      const parts = [];
      if ( newViews.length > 0 )
         parts.push( "new images " + newViews.join( ", " ) );
      if ( closedViews.length > 0 )
         parts.push( "closed images " + closedViews.join( ", " ) );
      if ( changedViews.length > 0 )
         parts.push( "changed images " + changedViews.map( change => change.view ).join( ", " ) );
      return parts.length > 0 ? message + " Before that, the code left behind: " + parts.join( "; " ) + "." : message;
   }
   catch ( error )
   {
      return message + " What the code changed before that could not be determined.";
   }
}

function textOf( error )
{
   return (error === null || error === undefined) ? "" + error : "" + (error.message || error);
}

// Line numbers count from the first line of the code, which sits on the second line here.
function lineOf( error )
{
   const match = /<anonymous>:(\d+):\d+/.exec( "" + (error && error.stack) );
   return match ? " (line " + (Number( match[1] ) - 1) + ")" : "";
}

let run;
try
{
   run = ( 0, eval )( "(function(){\n" + args.code + "\n})" );
}
catch ( error )
{
   ctx.fail( "code_error", "The code does not compile: " + textOf( error ) );
}

let value;
try
{
   value = run();
}
catch ( error )
{
   if ( ctx.isAbort( error ) )
      ctx.fail( "aborted", withChanges( "The code was aborted in PixInsight." ) );
   ctx.fail( "code_error", withChanges( "The code threw" + lineOf( error ) + ": " + textOf( error ) ) );
}

if ( value !== null && typeof value == "object" && typeof value.then == "function" )
   ctx.fail( "code_error", withChanges( "The code returned a promise. Nothing here waits for one: return the value itself." ) );
// JSON would drop these without a word.
if ( typeof value == "function" || typeof value == "symbol" )
   ctx.fail( "code_error", withChanges( "The code returned a " + typeof value + ", which JSON cannot hold. Return a value." ) );

let length;
try
{
   length = (ctx.toJson( value === undefined ? null : value ) || "").length;
}
catch ( error )
{
   ctx.fail( "code_error", withChanges( "The returned value cannot be turned into JSON: " + textOf( error ) ) );
}
if ( length > MAX_RESULT_LENGTH )
   ctx.fail( "code_error", withChanges( "The returned value takes " + length + " characters as JSON, and " + MAX_RESULT_LENGTH + " are the limit. Return less, or write it to a file." ) );

const report = ctx.changesSince( before );
report.value = value === undefined ? null : value;
return report;

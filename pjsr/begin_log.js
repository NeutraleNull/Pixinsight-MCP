#engine v8
// Sent right before a script that the server starts for the user. What that script writes to the
// console then goes to the job that reports on it, and the runner of that job ends this log.
// The image the script is meant for comes to the front once more, because the user may have
// clicked on another one since the check.
console.beginLog( Runtime.jsArguments[0] );
if ( Runtime.jsArguments.length > 1 )
{
   try
   {
      const view = View.viewById( Runtime.jsArguments[1] );
      if ( view !== null && !view.isNull )
         view.window.bringToFront();
   }
   catch ( error )
   {
      console.warningln( "** Could not bring " + Runtime.jsArguments[1] + " to the front: " + error );
   }
}

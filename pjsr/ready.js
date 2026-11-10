#engine v8
// Tells the server that an instance answers, and whether it runs unattended.
File.writeTextFile( Runtime.jsArguments[0] + ".tmp", JSON.stringify( { automation: CoreApplication.automationMode } ) );
File.move( Runtime.jsArguments[0] + ".tmp", Runtime.jsArguments[0] );

return {
   version: [ CoreApplication.versionMajor, CoreApplication.versionMinor, CoreApplication.versionRelease ].join( "." ),
   revision: CoreApplication.versionRevision,
   build: CoreApplication.versionBuild,
   codename: CoreApplication.versionCodename,
   instance: CoreApplication.instance,
   automationMode: CoreApplication.automationMode,
   v8: Runtime.v8Version,
   processes: MetaObject.externalObjects.length,
   // Where the scripts of the Script menu are, which only this installation knows.
   scriptsDir: (typeof coreSrcDirPath == "string") ? coreSrcDirPath + "/scripts" : null
};

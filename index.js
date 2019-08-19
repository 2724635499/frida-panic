const unsafeOperations = {};

module.exports = {
  handler: {
    install(sink) {
      Process.setExceptionHandler(exception => {
        sink.onPanic(preparePanic(exception.message, exception, exception.context));
      });

      if (Process.platform === 'darwin') {
        const objcThrow = Module.findExportByName('libobjc.A.dylib', 'objc_exception_throw');
        if (objcThrow !== null) {
          let potentialObjCPanic = null;

          Interceptor.attach(objcThrow, function (args) {
            const exception = new ObjC.Object(args[0]);
            const description = exception.toString();
            potentialObjCPanic = {
              description: description,
              details: preparePanic(`Unhandled Objective-C exception: ${description}`, {}, this.context)
            };
          });

          Interceptor.attach(Module.getExportByName('libsystem_c.dylib', 'abort'), {
            onEnter(args) {
              const isCausedByUnhandledObjCException = Thread.backtrace(this.context).map(DebugSymbol.fromAddress).some(symbol => {
                return symbol.moduleName === 'libobjc.A.dylib' && symbol.name === '_objc_terminate()';
              });
              if (isCausedByUnhandledObjCException) {
                const details = unsafeOperations[Process.getCurrentThreadId()];
                if (details !== undefined) {
                  details.exception = new Error(potentialObjCPanic.description);
                } else {
                  sink.onPanic(potentialObjCPanic.details);
                }
              }
            }
          });
        }
      }

      function preparePanic(message, details, cpuContext) {
        const backtrace = Thread.backtrace(cpuContext).map(DebugSymbol.fromAddress);

        return {
          message: message,
          details: details,
          stack: {
            native: backtrace.map(frame => frame.toString()).join('\n'),
            js: new Error().stack
          }
        };
      }
    }
  },
  performUnsafeOperation(operation) {
    const threadId = Process.getCurrentThreadId();

    const details = {
      exception: null
    };
    unsafeOperations[threadId] = details;

    try {
      return operation();
    } catch (e) {
      if (details.exception !== null)
        throw details.exception;
      else
        throw e;
    } finally {
      delete unsafeOperations[threadId];
    }
  },
  format(error) {
    return `********************************************************************************
${error.message}

Native stack:
${'\t' + error.stack.native.replace(/\n/g, '\n\t')}

JavaScript stack:
${'\t' + error.stack.js.replace(/\n/g, '\n\t')}

Details:
${'\t' + JSON.stringify(error.details, null, 4).replace(/\n/g, '\n\t')}
********************************************************************************
`;
  }
};

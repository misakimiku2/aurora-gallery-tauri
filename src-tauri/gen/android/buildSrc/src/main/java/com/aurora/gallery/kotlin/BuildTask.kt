import java.io.File
import org.apache.tools.ant.taskdefs.condition.Os
import org.gradle.api.DefaultTask
import org.gradle.api.GradleException
import org.gradle.api.logging.LogLevel
import org.gradle.api.tasks.Input
import org.gradle.api.tasks.TaskAction

open class BuildTask : DefaultTask() {
    @Input
    var rootDirRel: String? = null
    @Input
    var target: String? = null
    @Input
    var release: Boolean? = null

    @TaskAction
    fun assemble() {
        val executable = """npm""";
        try {
            runTauriCli(executable)
        } catch (e: Exception) {
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                // Try different Windows-specific extensions, plus common install
                // locations as a last resort (the Gradle Daemon may cache a stale
                // PATH that does not include the Node.js install directory).
                val fallbacks = listOf(
                    "$executable.exe",
                    "$executable.cmd",
                    "$executable.bat",
                    "C:\\Program Files\\nodejs\\npm.cmd",
                    "C:\\Program Files (x86)\\nodejs\\npm.cmd",
                )

                var lastException: Exception = e
                for (fallback in fallbacks) {
                    try {
                        runTauriCli(fallback)
                        return
                    } catch (fallbackException: Exception) {
                        logger.lifecycle("npm executable '{}' failed: {}", fallback, fallbackException.message)
                        lastException = fallbackException
                    }
                }
                throw lastException
            } else {
                throw e;
            }
        }
    }

    fun runTauriCli(executable: String) {
        val rootDirRel = rootDirRel ?: throw GradleException("rootDirRel cannot be null")
        val target = target ?: throw GradleException("target cannot be null")
        val release = release ?: throw GradleException("release cannot be null")
        val args = listOf("run", "--", "tauri", "android", "android-studio-script");

        project.exec {
            workingDir(File(project.projectDir, rootDirRel))
            executable(executable)
            args(args)
            // On Windows, ensure the Node.js install directory is in PATH so
            // that npm.cmd can locate node.exe even if the Gradle Daemon's PATH
            // is stale.
            if (Os.isFamily(Os.FAMILY_WINDOWS)) {
                val nodeDirs = listOf(
                    "C:\\Program Files\\nodejs",
                    "C:\\Program Files (x86)\\nodejs",
                )
                val currentPath = (environment["PATH"] as? String)
                    ?: System.getenv("PATH") ?: ""
                val missing = nodeDirs.filter { File(it).exists() && !currentPath.contains(it) }
                if (missing.isNotEmpty()) {
                    environment("PATH", missing.joinToString(";") + ";" + currentPath)
                }
            }
            if (project.logger.isEnabled(LogLevel.DEBUG)) {
                args("-vv")
            } else if (project.logger.isEnabled(LogLevel.INFO)) {
                args("-v")
            }
            if (release) {
                args("--release")
            }
            args(listOf("--target", target))
        }.assertNormalExitValue()
    }
}
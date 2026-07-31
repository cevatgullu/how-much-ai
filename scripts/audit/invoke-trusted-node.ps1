[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$NodePath,
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedNodeSha256,
    [string]$ScriptPath,
    [ValidatePattern('^[a-fA-F0-9]{64}$')]
    [string]$ExpectedScriptSha256,
    [string]$EncodedScriptArguments,
    [switch]$PassThruResult
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Throw-HmaTrustedNodeFailure {
    throw 'trusted-node-launch-failed'
}

function Initialize-HmaTrustedProcessJobType {
    if ($null -ne ('Hma.TrustedProcessJob' -as [type])) {
        return
    }

    Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading.Tasks;
using Microsoft.Win32.SafeHandles;

namespace Hma
{
    public sealed class SafeJobHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public SafeJobHandle() : base(true) { }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        protected override bool ReleaseHandle()
        {
            return CloseHandle(handle);
        }
    }

    public sealed class SafeKernelHandle : SafeHandleZeroOrMinusOneIsInvalid
    {
        public SafeKernelHandle() : base(true) { }

        internal SafeKernelHandle(IntPtr value) : base(true)
        {
            SetHandle(value);
        }

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        protected override bool ReleaseHandle()
        {
            return CloseHandle(handle);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct IoCounters
    {
        internal ulong ReadOperationCount;
        internal ulong WriteOperationCount;
        internal ulong OtherOperationCount;
        internal ulong ReadTransferCount;
        internal ulong WriteTransferCount;
        internal ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BasicLimitInformation
    {
        internal long PerProcessUserTimeLimit;
        internal long PerJobUserTimeLimit;
        internal uint LimitFlags;
        internal UIntPtr MinimumWorkingSetSize;
        internal UIntPtr MaximumWorkingSetSize;
        internal uint ActiveProcessLimit;
        internal UIntPtr Affinity;
        internal uint PriorityClass;
        internal uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ExtendedLimitInformation
    {
        internal BasicLimitInformation BasicLimitInformation;
        internal IoCounters IoInfo;
        internal UIntPtr ProcessMemoryLimit;
        internal UIntPtr JobMemoryLimit;
        internal UIntPtr PeakProcessMemoryUsed;
        internal UIntPtr PeakJobMemoryUsed;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct SecurityAttributes
    {
        internal int Length;
        internal IntPtr SecurityDescriptor;

        [MarshalAs(UnmanagedType.Bool)]
        internal bool InheritHandle;
    }

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    internal struct StartupInfo
    {
        internal int Size;
        internal string Reserved;
        internal string Desktop;
        internal string Title;
        internal int X;
        internal int Y;
        internal int XSize;
        internal int YSize;
        internal int XCountChars;
        internal int YCountChars;
        internal int FillAttribute;
        internal int Flags;
        internal short ShowWindow;
        internal short ReservedSize;
        internal IntPtr ReservedBytes;
        internal IntPtr StandardInput;
        internal IntPtr StandardOutput;
        internal IntPtr StandardError;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct StartupInfoEx
    {
        internal StartupInfo StartupInfo;
        internal IntPtr AttributeList;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct ProcessInformation
    {
        internal IntPtr Process;
        internal IntPtr Thread;
        internal uint ProcessId;
        internal uint ThreadId;
    }

    public sealed class TrustedNativeProcess : IDisposable
    {
        private SafeKernelHandle process;
        private StreamReader standardOutput;
        private StreamReader standardError;
        private bool exited;
        private int exitCode;

        internal TrustedNativeProcess(
            IntPtr processHandle,
            SafeFileHandle outputRead,
            SafeFileHandle errorRead
        )
        {
            process = new SafeKernelHandle(processHandle);
            UTF8Encoding strictUtf8 = new UTF8Encoding(false, true);
            standardOutput = new StreamReader(
                new FileStream(outputRead, FileAccess.Read, 4096, false),
                strictUtf8,
                false,
                4096
            );
            standardError = new StreamReader(
                new FileStream(errorRead, FileAccess.Read, 4096, false),
                strictUtf8,
                false,
                4096
            );
        }

        public Task<string> ReadStandardOutputToEndAsync()
        {
            return standardOutput.ReadToEndAsync();
        }

        public Task<string> ReadStandardErrorToEndAsync()
        {
            return standardError.ReadToEndAsync();
        }

        public void WaitForExit()
        {
            if (!exited)
            {
                TrustedProcessJob.WaitForProcess(process);
                exitCode = TrustedProcessJob.GetProcessExitCode(process);
                exited = true;
            }
        }

        public int ExitCode
        {
            get
            {
                if (!exited)
                {
                    throw new InvalidOperationException();
                }
                return exitCode;
            }
        }

        public void Dispose()
        {
            if (standardOutput != null)
            {
                standardOutput.Dispose();
                standardOutput = null;
            }
            if (standardError != null)
            {
                standardError.Dispose();
                standardError = null;
            }
            if (process != null)
            {
                process.Dispose();
                process = null;
            }
        }
    }

    public static class TrustedProcessJob
    {
        private const uint KillOnJobClose = 0x00002000;
        private const int ExtendedLimitInformationClass = 9;
        private const uint WaitObject0 = 0x00000000;
        private const uint WaitInfinite = 0xffffffff;
        private const int StartfUseStdHandles = 0x00000100;
        private const uint CreateSuspended = 0x00000004;
        private const uint CreateUnicodeEnvironment = 0x00000400;
        private const uint ExtendedStartupInfoPresent = 0x00080000;
        private const uint CreateNoWindow = 0x08000000;
        private const uint HandleFlagInherit = 0x00000001;
        private static readonly IntPtr HandleListAttribute =
            new IntPtr(0x00020002);

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            SetLastError = true
        )]
        private static extern SafeJobHandle CreateJobObject(
            IntPtr jobAttributes,
            string name
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetInformationJobObject(
            SafeJobHandle job,
            int informationClass,
            ref ExtendedLimitInformation information,
            uint informationLength
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CreatePipe(
            out SafeFileHandle readPipe,
            out SafeFileHandle writePipe,
            ref SecurityAttributes attributes,
            int size
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool SetHandleInformation(
            SafeFileHandle handle,
            uint mask,
            uint flags
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool InitializeProcThreadAttributeList(
            IntPtr attributeList,
            int attributeCount,
            int flags,
            ref IntPtr size
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool UpdateProcThreadAttribute(
            IntPtr attributeList,
            uint flags,
            IntPtr attribute,
            IntPtr value,
            IntPtr size,
            IntPtr previousValue,
            IntPtr returnSize
        );

        [DllImport("kernel32.dll")]
        private static extern void DeleteProcThreadAttributeList(
            IntPtr attributeList
        );

        [DllImport(
            "kernel32.dll",
            CharSet = CharSet.Unicode,
            SetLastError = true
        )]
        [return: MarshalAs(UnmanagedType.Bool)]
        private static extern bool CreateProcessW(
            string applicationName,
            StringBuilder commandLine,
            IntPtr processAttributes,
            IntPtr threadAttributes,
            [MarshalAs(UnmanagedType.Bool)] bool inheritHandles,
            uint creationFlags,
            IntPtr environment,
            string currentDirectory,
            ref StartupInfoEx startupInfo,
            out ProcessInformation processInformation
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool AssignProcessToJobObject(
            SafeJobHandle job,
            IntPtr process
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateJobObject(
            SafeJobHandle job,
            uint exitCode
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint WaitForSingleObject(
            SafeHandle handle,
            uint milliseconds
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern uint ResumeThread(IntPtr thread);

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool GetExitCodeProcess(
            SafeKernelHandle process,
            out uint exitCode
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool TerminateProcess(
            IntPtr process,
            uint exitCode
        );

        [DllImport("kernel32.dll", SetLastError = true)]
        private static extern bool CloseHandle(IntPtr handle);

        public static SafeJobHandle CreateKillOnClose()
        {
            SafeJobHandle job = CreateJobObject(IntPtr.Zero, null);
            if (job == null || job.IsInvalid)
            {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }

            ExtendedLimitInformation information =
                new ExtendedLimitInformation();
            information.BasicLimitInformation.LimitFlags = KillOnJobClose;
            if (!SetInformationJobObject(
                    job,
                    ExtendedLimitInformationClass,
                    ref information,
                    (uint)Marshal.SizeOf(typeof(ExtendedLimitInformation))
                ))
            {
                int error = Marshal.GetLastWin32Error();
                job.Dispose();
                throw new Win32Exception(error);
            }
            return job;
        }

        private static string BuildEnvironmentBlock(string[] entries)
        {
            if (entries == null || entries.Length == 0 ||
                entries.Length > 64)
            {
                throw new ArgumentException();
            }
            List<string> reviewed = new List<string>();
            HashSet<string> names = new HashSet<string>(
                StringComparer.OrdinalIgnoreCase
            );
            foreach (string entry in entries)
            {
                if (String.IsNullOrEmpty(entry) ||
                    entry.IndexOf('\0') >= 0)
                {
                    throw new ArgumentException();
                }
                int separator = entry.IndexOf('=');
                if (separator <= 0 ||
                    !names.Add(entry.Substring(0, separator)))
                {
                    throw new ArgumentException();
                }
                reviewed.Add(entry);
            }
            reviewed.Sort(StringComparer.OrdinalIgnoreCase);
            return String.Join("\0", reviewed.ToArray()) + "\0\0";
        }

        public static TrustedNativeProcess StartSuspendedAssigned(
            string applicationName,
            string commandLine,
            string workingDirectory,
            string[] environmentEntries,
            SafeJobHandle job
        )
        {
            if (String.IsNullOrEmpty(applicationName) ||
                String.IsNullOrEmpty(commandLine) ||
                String.IsNullOrEmpty(workingDirectory) ||
                job == null || job.IsInvalid || job.IsClosed)
            {
                throw new ArgumentException();
            }

            SafeFileHandle outputRead = null;
            SafeFileHandle outputWrite = null;
            SafeFileHandle errorRead = null;
            SafeFileHandle errorWrite = null;
            SafeFileHandle inputRead = null;
            SafeFileHandle inputWrite = null;
            IntPtr attributeList = IntPtr.Zero;
            IntPtr handleList = IntPtr.Zero;
            IntPtr environment = IntPtr.Zero;
            ProcessInformation processInformation =
                new ProcessInformation();
            bool processCreated = false;
            bool processAssigned = false;
            bool attributeListInitialized = false;
            bool outputTransferred = false;
            bool errorTransferred = false;

            try
            {
                SecurityAttributes attributes = new SecurityAttributes();
                attributes.Length =
                    Marshal.SizeOf(typeof(SecurityAttributes));
                attributes.InheritHandle = true;
                if (!CreatePipe(
                        out outputRead,
                        out outputWrite,
                        ref attributes,
                        0
                    ) ||
                    !CreatePipe(
                        out errorRead,
                        out errorWrite,
                        ref attributes,
                        0
                    ) ||
                    !CreatePipe(
                        out inputRead,
                        out inputWrite,
                        ref attributes,
                        0
                    ) ||
                    !SetHandleInformation(
                        outputRead,
                        HandleFlagInherit,
                        0
                    ) ||
                    !SetHandleInformation(
                        errorRead,
                        HandleFlagInherit,
                        0
                    ) ||
                    !SetHandleInformation(
                        inputWrite,
                        HandleFlagInherit,
                        0
                    ))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error()
                    );
                }

                IntPtr attributeListSize = IntPtr.Zero;
                InitializeProcThreadAttributeList(
                    IntPtr.Zero,
                    1,
                    0,
                    ref attributeListSize
                );
                if (attributeListSize == IntPtr.Zero)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error()
                    );
                }
                attributeList = Marshal.AllocHGlobal(attributeListSize);
                if (!InitializeProcThreadAttributeList(
                        attributeList,
                        1,
                        0,
                        ref attributeListSize
                    ))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error()
                    );
                }
                attributeListInitialized = true;

                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(
                    handleList,
                    0,
                    inputRead.DangerousGetHandle()
                );
                Marshal.WriteIntPtr(
                    handleList,
                    IntPtr.Size,
                    outputWrite.DangerousGetHandle()
                );
                Marshal.WriteIntPtr(
                    handleList,
                    IntPtr.Size * 2,
                    errorWrite.DangerousGetHandle()
                );
                if (!UpdateProcThreadAttribute(
                        attributeList,
                        0,
                        HandleListAttribute,
                        handleList,
                        new IntPtr(IntPtr.Size * 3),
                        IntPtr.Zero,
                        IntPtr.Zero
                    ))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error()
                    );
                }

                environment = Marshal.StringToHGlobalUni(
                    BuildEnvironmentBlock(environmentEntries)
                );
                StartupInfoEx startupInfo = new StartupInfoEx();
                startupInfo.StartupInfo.Size =
                    Marshal.SizeOf(typeof(StartupInfoEx));
                startupInfo.StartupInfo.Flags =
                    StartfUseStdHandles;
                startupInfo.StartupInfo.StandardInput =
                    inputRead.DangerousGetHandle();
                startupInfo.StartupInfo.StandardOutput =
                    outputWrite.DangerousGetHandle();
                startupInfo.StartupInfo.StandardError =
                    errorWrite.DangerousGetHandle();
                startupInfo.AttributeList = attributeList;

                if (!CreateProcessW(
                        applicationName,
                        new StringBuilder(commandLine),
                        IntPtr.Zero,
                        IntPtr.Zero,
                        true,
                        CreateSuspended |
                            CreateUnicodeEnvironment |
                            ExtendedStartupInfoPresent |
                            CreateNoWindow,
                        environment,
                        workingDirectory,
                        ref startupInfo,
                        out processInformation
                    ))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error()
                    );
                }
                processCreated = true;

                if (!AssignProcessToJobObject(
                        job,
                        processInformation.Process
                    ))
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error()
                    );
                }
                processAssigned = true;

                if (ResumeThread(processInformation.Thread) ==
                    UInt32.MaxValue)
                {
                    throw new Win32Exception(
                        Marshal.GetLastWin32Error()
                    );
                }

                TrustedNativeProcess result =
                    new TrustedNativeProcess(
                        processInformation.Process,
                        outputRead,
                        errorRead
                    );
                processInformation.Process = IntPtr.Zero;
                outputTransferred = true;
                errorTransferred = true;
                return result;
            }
            finally
            {
                if (processCreated &&
                    processInformation.Process != IntPtr.Zero)
                {
                    if (processAssigned)
                    {
                        TerminateJobObject(job, 1);
                        WaitForSingleObject(job, WaitInfinite);
                    }
                    else
                    {
                        SafeKernelHandle failedProcess =
                            new SafeKernelHandle(
                                processInformation.Process
                            );
                        processInformation.Process = IntPtr.Zero;
                        try
                        {
                            TerminateProcess(
                                failedProcess.DangerousGetHandle(),
                                1
                            );
                            WaitForSingleObject(
                                failedProcess,
                                WaitInfinite
                            );
                        }
                        finally
                        {
                            failedProcess.Dispose();
                        }
                    }
                }
                if (processInformation.Process != IntPtr.Zero)
                {
                    CloseHandle(processInformation.Process);
                }
                if (processInformation.Thread != IntPtr.Zero)
                {
                    CloseHandle(processInformation.Thread);
                }
                if (inputRead != null) inputRead.Dispose();
                if (inputWrite != null) inputWrite.Dispose();
                if (outputWrite != null) outputWrite.Dispose();
                if (errorWrite != null) errorWrite.Dispose();
                if (!outputTransferred && outputRead != null)
                {
                    outputRead.Dispose();
                }
                if (!errorTransferred && errorRead != null)
                {
                    errorRead.Dispose();
                }
                if (attributeListInitialized)
                {
                    DeleteProcThreadAttributeList(attributeList);
                }
                if (attributeList != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(attributeList);
                }
                if (handleList != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(handleList);
                }
                if (environment != IntPtr.Zero)
                {
                    Marshal.FreeHGlobal(environment);
                }
            }
        }

        internal static void WaitForProcess(
            SafeKernelHandle process
        )
        {
            if (process == null || process.IsInvalid ||
                process.IsClosed ||
                WaitForSingleObject(process, WaitInfinite) !=
                    WaitObject0)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error()
                );
            }
        }

        internal static int GetProcessExitCode(
            SafeKernelHandle process
        )
        {
            uint exitCode;
            if (!GetExitCodeProcess(process, out exitCode))
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error()
                );
            }
            return unchecked((int)exitCode);
        }

        public static void TerminateAndWait(
            SafeJobHandle job,
            TrustedNativeProcess process
        )
        {
            if (job == null || job.IsInvalid || job.IsClosed)
            {
                throw new InvalidOperationException();
            }
            TerminateJobObject(job, 1);
            if (WaitForSingleObject(job, WaitInfinite) != WaitObject0)
            {
                throw new Win32Exception(
                    Marshal.GetLastWin32Error()
                );
            }
            if (process != null)
            {
                process.WaitForExit();
            }
        }
    }
}
'@
}

function Stop-HmaTrustedProcessTree {
    param(
        $JobHandle,
        $Process
    )

    if ($null -eq $JobHandle) {
        Throw-HmaTrustedNodeFailure
    }
    [Hma.TrustedProcessJob]::TerminateAndWait(
        $JobHandle,
        $Process
    )
    $JobHandle.Dispose()
}

function Test-HmaControlCharacter {
    param([string]$Value)

    foreach ($character in $Value.ToCharArray()) {
        if ([char]::IsControl($character)) {
            return $true
        }
    }
    return $false
}

function Assert-HmaOrdinaryPathHierarchy {
    param(
        [string]$FullPath,
        [bool]$LeafIsFile
    )

    $current = $FullPath
    $isLeaf = $true
    while ($null -ne $current) {
        $attributes = [IO.File]::GetAttributes($current)
        if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-HmaTrustedNodeFailure
        }
        $isDirectory = (($attributes -band [IO.FileAttributes]::Directory) -ne 0)
        if (($isLeaf -and $LeafIsFile -and $isDirectory) -or
            ($isLeaf -and -not $LeafIsFile -and -not $isDirectory) -or
            (-not $isLeaf -and -not $isDirectory)) {
            Throw-HmaTrustedNodeFailure
        }

        $parent = [IO.Directory]::GetParent($current)
        if ($null -eq $parent) {
            $current = $null
        } else {
            $current = $parent.FullName
            $isLeaf = $false
        }
    }
}

function Assert-HmaOrdinaryAbsoluteFile {
    param(
        [string]$Candidate,
        [string]$ExpectedLeafName
    )

    if ([string]::IsNullOrWhiteSpace($Candidate) -or
        $Candidate.Length -gt 32760 -or
        (Test-HmaControlCharacter -Value $Candidate) -or
        $Candidate.Contains('/') -or
        -not [IO.Path]::IsPathRooted($Candidate)) {
        Throw-HmaTrustedNodeFailure
    }

    $fullPath = [IO.Path]::GetFullPath($Candidate)
    $root = [IO.Path]::GetPathRoot($fullPath)
    if ($root -cnotmatch '^[A-Za-z]:\\$' -or
        -not [string]::Equals(
            $Candidate,
            $fullPath,
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        $fullPath.Substring(2).Contains(':') -or
        -not [string]::Equals(
            [IO.Path]::GetFileName($fullPath),
            $ExpectedLeafName,
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not [IO.File]::Exists($fullPath)) {
        Throw-HmaTrustedNodeFailure
    }

    foreach ($segment in $fullPath.Substring($root.Length).Split('\')) {
        if ([string]::IsNullOrEmpty($segment) -or
            $segment.EndsWith(' ') -or
            $segment.EndsWith('.')) {
            Throw-HmaTrustedNodeFailure
        }
    }

    Assert-HmaOrdinaryPathHierarchy -FullPath $fullPath -LeafIsFile $true
    return $fullPath
}

function Assert-HmaOrdinaryAbsoluteDirectory {
    param([string]$Candidate)

    if ([string]::IsNullOrWhiteSpace($Candidate) -or
        $Candidate.Length -gt 32760 -or
        (Test-HmaControlCharacter -Value $Candidate) -or
        $Candidate.Contains('/') -or
        -not [IO.Path]::IsPathRooted($Candidate)) {
        Throw-HmaTrustedNodeFailure
    }

    $fullPath = [IO.Path]::GetFullPath($Candidate)
    $root = [IO.Path]::GetPathRoot($fullPath)
    if ($root -cnotmatch '^[A-Za-z]:\\$' -or
        -not [string]::Equals(
            $Candidate,
            $fullPath,
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        $fullPath.Substring(2).Contains(':') -or
        -not [IO.Directory]::Exists($fullPath)) {
        Throw-HmaTrustedNodeFailure
    }

    Assert-HmaOrdinaryPathHierarchy -FullPath $fullPath -LeafIsFile $false
    return $fullPath
}

function Assert-HmaSafeNpmTreeName {
    param([string]$Value)

    if ([string]::IsNullOrEmpty($Value) -or
        $Value.Length -gt 255 -or
        -not [string]::Equals(
            $Value.Normalize([Text.NormalizationForm]::FormC),
            $Value,
            [StringComparison]::Ordinal
        ) -or
        (Test-HmaControlCharacter -Value $Value) -or
        $Value.IndexOfAny([char[]]@('/', '\', ':')) -ge 0 -or
        $Value.EndsWith(' ') -or
        $Value.EndsWith('.')) {
        Throw-HmaTrustedNodeFailure
    }
}

function Get-HmaOrdinalDirectoryNames {
    param([string]$DirectoryPath)

    $entries = [IO.Directory]::GetFileSystemEntries($DirectoryPath)
    $names = New-Object 'Collections.Generic.List[string]'
    $seen = @{}
    foreach ($entryPath in $entries) {
        $name = [IO.Path]::GetFileName($entryPath)
        Assert-HmaSafeNpmTreeName -Value $name
        $folded = $name.ToLowerInvariant()
        if ($seen.ContainsKey($folded)) {
            Throw-HmaTrustedNodeFailure
        }
        $seen[$folded] = $true
        [void]$names.Add($name)
    }
    $names.Sort([StringComparer]::Ordinal)
    return [string[]]$names.ToArray()
}

function Test-HmaExactStringArray {
    param(
        [string[]]$Left,
        [string[]]$Right
    )

    if ($Left.Count -ne $Right.Count) {
        return $false
    }
    for ($index = 0; $index -lt $Left.Count; $index += 1) {
        if (-not [string]::Equals(
                $Left[$index],
                $Right[$index],
                [StringComparison]::Ordinal
            )) {
            return $false
        }
    }
    return $true
}

function Add-HmaUtf8Bytes {
    param(
        [IO.Stream]$Stream,
        [string]$Value
    )

    $bytes = [Text.Encoding]::UTF8.GetBytes($Value)
    try {
        $Stream.Write($bytes, 0, $bytes.Length)
    } finally {
        if ($bytes.Length -gt 0) {
            [Array]::Clear($bytes, 0, $bytes.Length)
        }
    }
}

function Get-HmaLockedStreamSha256 {
    param([IO.Stream]$Stream)

    $originalPosition = $Stream.Position
    try {
        $Stream.Position = 0
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString(
                    $sha256.ComputeHash($Stream)
                )).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $Stream.Position = $originalPosition
    }
}

function Get-HmaNpmTreeLeaseSha256 {
    param($Lease)

    if ($null -eq $Lease -or
        $null -eq $Lease.SortedPaths -or
        $null -eq $Lease.RecordByPath) {
        Throw-HmaTrustedNodeFailure
    }

    $aggregateInput = New-Object IO.MemoryStream
    try {
        Add-HmaUtf8Bytes `
            -Stream $aggregateInput `
            -Value ("HMA-NPM-TREE-V1" + [char]0)
        foreach ($relativePath in $Lease.SortedPaths) {
            $record = $Lease.RecordByPath[$relativePath]
            if ($null -eq $record -or
                ($record.Type -cne 'D' -and $record.Type -cne 'F')) {
                Throw-HmaTrustedNodeFailure
            }
            Add-HmaUtf8Bytes `
                -Stream $aggregateInput `
                -Value (
                    [string]$record.Type +
                    [char]0 +
                    [string]$record.RelativePath +
                    [char]0
                )
            if ($record.Type -ceq 'F') {
                if ($null -eq $record.Stream -or
                    [Int64]$record.Stream.Length -ne [Int64]$record.Size) {
                    Throw-HmaTrustedNodeFailure
                }
                $fileSha256 = Get-HmaLockedStreamSha256 `
                    -Stream $record.Stream
                $sizeText = [string]::Format(
                    [Globalization.CultureInfo]::InvariantCulture,
                    '{0}',
                    [Int64]$record.Size
                )
                Add-HmaUtf8Bytes `
                    -Stream $aggregateInput `
                    -Value (
                        $sizeText +
                        [char]0 +
                        $fileSha256 +
                        [char]0
                    )
            }
        }
        $aggregateInput.Position = 0
        $sha256 = [Security.Cryptography.SHA256]::Create()
        try {
            return ([BitConverter]::ToString(
                    $sha256.ComputeHash($aggregateInput)
                )).Replace('-', '').ToLowerInvariant()
        } finally {
            $sha256.Dispose()
        }
    } finally {
        $aggregateInput.Dispose()
    }
}

function Assert-HmaNpmTreeLease {
    param(
        $Lease,
        [ValidatePattern('^[a-fA-F0-9]{64}$')]
        [string]$ExpectedSha256
    )

    if ($null -eq $Lease -or
        $null -eq $Lease.DirectorySnapshots -or
        $null -eq $Lease.SortedPaths -or
        $null -eq $Lease.RecordByPath) {
        Throw-HmaTrustedNodeFailure
    }
    foreach ($snapshot in $Lease.DirectorySnapshots) {
        $attributes = [IO.File]::GetAttributes([string]$snapshot.Path)
        if (($attributes -band [IO.FileAttributes]::Directory) -eq 0 -or
            ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            Throw-HmaTrustedNodeFailure
        }
        $currentNames = @(
            Get-HmaOrdinalDirectoryNames `
                -DirectoryPath ([string]$snapshot.Path)
        )
        if (-not (Test-HmaExactStringArray `
                -Left ([string[]]$snapshot.Names) `
                -Right $currentNames)) {
            Throw-HmaTrustedNodeFailure
        }
    }
    foreach ($relativePath in $Lease.SortedPaths) {
        $record = $Lease.RecordByPath[$relativePath]
        if ($record.Type -cne 'F') {
            continue
        }
        $attributes = [IO.File]::GetAttributes([string]$record.Path)
        if (($attributes -band [IO.FileAttributes]::Directory) -ne 0 -or
            ($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [Int64]$record.Stream.Length -ne [Int64]$record.Size) {
            Throw-HmaTrustedNodeFailure
        }
    }
    $observedSha256 = Get-HmaNpmTreeLeaseSha256 -Lease $Lease
    if (-not [string]::Equals(
            $observedSha256,
            $ExpectedSha256,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        Throw-HmaTrustedNodeFailure
    }
    return $true
}

function Exit-HmaNpmTreeLease {
    param($Lease)

    if ($null -eq $Lease -or $null -eq $Lease.Streams) {
        return
    }
    for ($index = $Lease.Streams.Count - 1; $index -ge 0; $index -= 1) {
        if ($null -ne $Lease.Streams[$index]) {
            $Lease.Streams[$index].Dispose()
        }
    }
    $Lease.Streams.Clear()
}

function Assert-HmaProtectedDirectoryAcl {
    param([string]$DirectoryPath)

    $trustedDirectory = Assert-HmaOrdinaryAbsoluteDirectory `
        -Candidate $DirectoryPath
    $security = [IO.Directory]::GetAccessControl(
        $trustedDirectory,
        (
            [Security.AccessControl.AccessControlSections]::Access -bor
            [Security.AccessControl.AccessControlSections]::Owner
        )
    )
    if (-not $security.AreAccessRulesCanonical) {
        Throw-HmaTrustedNodeFailure
    }
    $owner = $security.GetOwner(
        [Security.Principal.SecurityIdentifier]
    ).Value
    $trustedInstallerSid = (
        'S-1-5-80-956008885-3418522649-1831038044-' +
        '1853292631-2271478464'
    )
    $safeWriters = @{
        'S-1-5-18' = $true
        'S-1-5-32-544' = $true
        $trustedInstallerSid = $true
    }
    if (-not $safeWriters.ContainsKey($owner)) {
        Throw-HmaTrustedNodeFailure
    }

    $dangerousRights = [Int64](
        [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::CreateFiles -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    )
    $dangerousRights = $dangerousRights -bor 268435456 -bor 1073741824
    $rules = $security.GetAccessRules(
        $true,
        $true,
        [Security.Principal.SecurityIdentifier]
    )
    $sawSystemWriter = $false
    $sawAdministratorWriter = $false
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -ne
            [Security.AccessControl.AccessControlType]::Allow) {
            Throw-HmaTrustedNodeFailure
        }
        $rights = ([Int64]$rule.FileSystemRights) -band 4294967295
        if (($rights -band $dangerousRights) -eq 0) {
            continue
        }
        $sid = $rule.IdentityReference.Value
        $creatorOwnerOnly = (
            $sid -ceq 'S-1-3-0' -and
            $rule.PropagationFlags -band
                [Security.AccessControl.PropagationFlags]::InheritOnly
        )
        if (-not $safeWriters.ContainsKey($sid) -and
            -not $creatorOwnerOnly) {
            Throw-HmaTrustedNodeFailure
        }
        if ($sid -ceq 'S-1-5-18') {
            $sawSystemWriter = $true
        }
        if ($sid -ceq 'S-1-5-32-544') {
            $sawAdministratorWriter = $true
        }
    }
    if (-not $sawSystemWriter -or -not $sawAdministratorWriter) {
        Throw-HmaTrustedNodeFailure
    }
    return $true
}

function Assert-HmaProtectedFileAcl {
    param([string]$FilePath)

    $trustedFile = Assert-HmaOrdinaryAbsoluteFile `
        -Candidate $FilePath `
        -ExpectedLeafName ([IO.Path]::GetFileName($FilePath))
    $security = [IO.File]::GetAccessControl(
        $trustedFile,
        (
            [Security.AccessControl.AccessControlSections]::Access -bor
            [Security.AccessControl.AccessControlSections]::Owner
        )
    )
    if (-not $security.AreAccessRulesCanonical) {
        Throw-HmaTrustedNodeFailure
    }
    $owner = $security.GetOwner(
        [Security.Principal.SecurityIdentifier]
    ).Value
    $trustedInstallerSid = (
        'S-1-5-80-956008885-3418522649-1831038044-' +
        '1853292631-2271478464'
    )
    $safeWriters = @{
        'S-1-5-18' = $true
        'S-1-5-32-544' = $true
        $trustedInstallerSid = $true
    }
    if (-not $safeWriters.ContainsKey($owner)) {
        Throw-HmaTrustedNodeFailure
    }

    $dangerousRights = [Int64](
        [Security.AccessControl.FileSystemRights]::WriteData -bor
        [Security.AccessControl.FileSystemRights]::CreateFiles -bor
        [Security.AccessControl.FileSystemRights]::AppendData -bor
        [Security.AccessControl.FileSystemRights]::CreateDirectories -bor
        [Security.AccessControl.FileSystemRights]::WriteExtendedAttributes -bor
        [Security.AccessControl.FileSystemRights]::DeleteSubdirectoriesAndFiles -bor
        [Security.AccessControl.FileSystemRights]::WriteAttributes -bor
        [Security.AccessControl.FileSystemRights]::Delete -bor
        [Security.AccessControl.FileSystemRights]::ChangePermissions -bor
        [Security.AccessControl.FileSystemRights]::TakeOwnership
    )
    $dangerousRights = $dangerousRights -bor 268435456 -bor 1073741824
    $rules = $security.GetAccessRules(
        $true,
        $true,
        [Security.Principal.SecurityIdentifier]
    )
    $sawSystemWriter = $false
    $sawAdministratorWriter = $false
    foreach ($rule in $rules) {
        if ($rule.AccessControlType -ne
            [Security.AccessControl.AccessControlType]::Allow) {
            Throw-HmaTrustedNodeFailure
        }
        $rights = ([Int64]$rule.FileSystemRights) -band 4294967295
        if (($rights -band $dangerousRights) -eq 0) {
            continue
        }
        $sid = $rule.IdentityReference.Value
        $creatorOwnerOnly = (
            $sid -ceq 'S-1-3-0' -and
            $rule.PropagationFlags -band
                [Security.AccessControl.PropagationFlags]::InheritOnly
        )
        if (-not $safeWriters.ContainsKey($sid) -and
            -not $creatorOwnerOnly) {
            Throw-HmaTrustedNodeFailure
        }
        if ($sid -ceq 'S-1-5-18') {
            $sawSystemWriter = $true
        }
        if ($sid -ceq 'S-1-5-32-544') {
            $sawAdministratorWriter = $true
        }
    }
    if (-not $sawSystemWriter -or -not $sawAdministratorWriter) {
        Throw-HmaTrustedNodeFailure
    }
    return $true
}

function Assert-HmaProtectedNpmLeaseAcl {
    param(
        $Lease,
        [string]$NodeDirectory
    )

    $identity = [Security.Principal.WindowsIdentity]::GetCurrent()
    try {
        $principal = New-Object Security.Principal.WindowsPrincipal($identity)
        if ($principal.IsInRole(
                [Security.Principal.WindowsBuiltInRole]::Administrator
            )) {
            Throw-HmaTrustedNodeFailure
        }
    } finally {
        $identity.Dispose()
    }
    $trustedNodeDirectory = Assert-HmaOrdinaryAbsoluteDirectory `
        -Candidate $NodeDirectory
    $programFilesDirectory = Assert-HmaOrdinaryAbsoluteDirectory `
        -Candidate ([IO.Directory]::GetParent(
                $trustedNodeDirectory
            ).FullName)
    $expectedProgramFiles = [IO.Path]::Combine(
        [IO.Path]::GetPathRoot([Environment]::SystemDirectory),
        'Program Files'
    )
    if (-not [string]::Equals(
            $programFilesDirectory,
            $expectedProgramFiles,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        Throw-HmaTrustedNodeFailure
    }

    $directories = @{}
    foreach ($candidate in @(
            $programFilesDirectory,
            $trustedNodeDirectory,
            [IO.Path]::GetDirectoryName([string]$Lease.NpmRoot),
            [string]$Lease.NpmRoot
        )) {
        $directories[$candidate.ToLowerInvariant()] = $candidate
    }
    foreach ($snapshot in $Lease.DirectorySnapshots) {
        $candidate = [string]$snapshot.Path
        $directories[$candidate.ToLowerInvariant()] = $candidate
    }
    foreach ($candidate in $directories.Values) {
        if (-not (Assert-HmaProtectedDirectoryAcl `
                -DirectoryPath $candidate)) {
            Throw-HmaTrustedNodeFailure
        }
    }
    foreach ($record in $Lease.RecordByPath.Values) {
        if ([string]$record.Type -ceq 'F' -and
            -not (Assert-HmaProtectedFileAcl `
                -FilePath ([string]$record.Path))) {
            Throw-HmaTrustedNodeFailure
        }
    }
    return $true
}

function Enter-HmaNpmTreeLease {
    param(
        [string]$NpmPath,
        [string]$NpmRoot,
        [ValidatePattern('^[a-fA-F0-9]{64}$')]
        [string]$ExpectedSha256
    )

    $streams = New-Object 'Collections.Generic.List[IO.FileStream]'
    try {
        $trustedNpmPath = Assert-HmaOrdinaryAbsoluteFile `
            -Candidate $NpmPath `
            -ExpectedLeafName 'npm.cmd'
        $trustedNpmRoot = Assert-HmaOrdinaryAbsoluteDirectory `
            -Candidate $NpmRoot
        $expectedNpmRoot = [IO.Path]::Combine(
            [IO.Path]::GetDirectoryName($trustedNpmPath),
            'node_modules',
            'npm'
        )
        if (-not [string]::Equals(
                $trustedNpmRoot,
                $expectedNpmRoot,
                [StringComparison]::OrdinalIgnoreCase
            )) {
            Throw-HmaTrustedNodeFailure
        }

        $recordByPath = @{}
        $sortedPaths = New-Object 'Collections.Generic.List[string]'
        $directorySnapshots = New-Object 'Collections.Generic.List[object]'
        $seenPaths = @{}
        $totalBytes = [Int64]0

        foreach ($directoryRecord in @(
                [pscustomobject]@{
                    Type = 'D'
                    RelativePath = 'node_modules'
                    Path = [IO.Path]::GetDirectoryName($trustedNpmRoot)
                    Stream = $null
                    Size = [Int64]0
                },
                [pscustomobject]@{
                    Type = 'D'
                    RelativePath = 'node_modules/npm'
                    Path = $trustedNpmRoot
                    Stream = $null
                    Size = [Int64]0
                }
            )) {
            $recordByPath[$directoryRecord.RelativePath] = $directoryRecord
            [void]$sortedPaths.Add($directoryRecord.RelativePath)
            $seenPaths[$directoryRecord.RelativePath.ToLowerInvariant()] = $true
        }

        $npmCommandStream = [IO.File]::Open(
            $trustedNpmPath,
            [IO.FileMode]::Open,
            [IO.FileAccess]::Read,
            [IO.FileShare]::Read
        )
        [void]$streams.Add($npmCommandStream)
        if ($npmCommandStream.Length -gt 268435456) {
            Throw-HmaTrustedNodeFailure
        }
        $totalBytes += $npmCommandStream.Length
        $npmCommandRecord = [pscustomobject]@{
            Type = 'F'
            RelativePath = 'npm.cmd'
            Path = $trustedNpmPath
            Stream = $npmCommandStream
            Size = [Int64]$npmCommandStream.Length
        }
        $recordByPath[$npmCommandRecord.RelativePath] = $npmCommandRecord
        [void]$sortedPaths.Add($npmCommandRecord.RelativePath)
        $seenPaths[$npmCommandRecord.RelativePath.ToLowerInvariant()] = $true

        $pendingDirectories = New-Object 'Collections.Generic.Stack[object]'
        $pendingDirectories.Push([pscustomobject]@{
                Path = $trustedNpmRoot
                RelativePath = 'node_modules/npm'
            })
        while ($pendingDirectories.Count -gt 0) {
            $directory = $pendingDirectories.Pop()
            $directoryPath = Assert-HmaOrdinaryAbsoluteDirectory `
                -Candidate ([string]$directory.Path)
            $namesBefore = @(
                Get-HmaOrdinalDirectoryNames `
                    -DirectoryPath $directoryPath
            )
            [void]$directorySnapshots.Add([pscustomobject]@{
                    Path = $directoryPath
                    Names = $namesBefore
                })
            foreach ($name in $namesBefore) {
                $absolutePath = [IO.Path]::Combine($directoryPath, $name)
                $relativePath = (
                    [string]$directory.RelativePath +
                    '/' +
                    $name
                )
                $foldedPath = $relativePath.ToLowerInvariant()
                if ($seenPaths.ContainsKey($foldedPath) -or
                    $recordByPath.Count -ge 100000) {
                    Throw-HmaTrustedNodeFailure
                }
                $seenPaths[$foldedPath] = $true
                $attributes = [IO.File]::GetAttributes($absolutePath)
                if (($attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                    Throw-HmaTrustedNodeFailure
                }
                if (($attributes -band [IO.FileAttributes]::Directory) -ne 0) {
                    $record = [pscustomobject]@{
                        Type = 'D'
                        RelativePath = $relativePath
                        Path = $absolutePath
                        Stream = $null
                        Size = [Int64]0
                    }
                    $recordByPath[$relativePath] = $record
                    [void]$sortedPaths.Add($relativePath)
                    $pendingDirectories.Push([pscustomobject]@{
                            Path = $absolutePath
                            RelativePath = $relativePath
                        })
                    continue
                }

                $fileStream = [IO.File]::Open(
                    $absolutePath,
                    [IO.FileMode]::Open,
                    [IO.FileAccess]::Read,
                    [IO.FileShare]::Read
                )
                [void]$streams.Add($fileStream)
                if ($fileStream.Length -gt 268435456) {
                    Throw-HmaTrustedNodeFailure
                }
                $totalBytes += $fileStream.Length
                if ($totalBytes -gt 1073741824) {
                    Throw-HmaTrustedNodeFailure
                }
                $record = [pscustomobject]@{
                    Type = 'F'
                    RelativePath = $relativePath
                    Path = $absolutePath
                    Stream = $fileStream
                    Size = [Int64]$fileStream.Length
                }
                $recordByPath[$relativePath] = $record
                [void]$sortedPaths.Add($relativePath)
            }
            $namesAfter = @(
                Get-HmaOrdinalDirectoryNames `
                    -DirectoryPath $directoryPath
            )
            if (-not (Test-HmaExactStringArray `
                    -Left $namesBefore `
                    -Right $namesAfter)) {
                Throw-HmaTrustedNodeFailure
            }
        }
        $sortedPaths.Sort([StringComparer]::Ordinal)
        $lease = [pscustomobject]@{
            NpmPath = $trustedNpmPath
            NpmRoot = $trustedNpmRoot
            Streams = $streams
            RecordByPath = $recordByPath
            SortedPaths = [string[]]$sortedPaths.ToArray()
            DirectorySnapshots = [object[]]$directorySnapshots.ToArray()
        }
        if (-not (Assert-HmaNpmTreeLease `
                -Lease $lease `
                -ExpectedSha256 $ExpectedSha256)) {
            Throw-HmaTrustedNodeFailure
        }
        return $lease
    } catch {
        for ($index = $streams.Count - 1; $index -ge 0; $index -= 1) {
            if ($null -ne $streams[$index]) {
                $streams[$index].Dispose()
            }
        }
        $streams.Clear()
        Throw-HmaTrustedNodeFailure
    }
}

function Assert-HmaSafeScriptArgument {
    param([string]$Value)

    if ($null -eq $Value -or
        $Value.Length -gt 8192 -or
        (Test-HmaControlCharacter -Value $Value) -or
        $Value -match '^(?i:-r$|--require(?:=|$)|--import(?:=|$)|--loader(?:=|$)|--experimental-loader(?:=|$)|node_options=|node_path=|npm_config_node_options=)') {
        Throw-HmaTrustedNodeFailure
    }
    return $Value
}

function ConvertTo-HmaWindowsCommandLineArgument {
    param([string]$Value)

    if ($Value.Length -gt 0 -and $Value -notmatch '[\s"]') {
        return $Value
    }

    $builder = New-Object Text.StringBuilder
    [void]$builder.Append('"')
    $backslashCount = 0
    foreach ($character in $Value.ToCharArray()) {
        if ($character -ceq '\') {
            $backslashCount += 1
            continue
        }
        if ($character -ceq '"') {
            [void]$builder.Append(('\' * (($backslashCount * 2) + 1)))
            [void]$builder.Append('"')
            $backslashCount = 0
            continue
        }
        if ($backslashCount -gt 0) {
            [void]$builder.Append(('\' * $backslashCount))
            $backslashCount = 0
        }
        [void]$builder.Append($character)
    }
    if ($backslashCount -gt 0) {
        [void]$builder.Append(('\' * ($backslashCount * 2)))
    }
    [void]$builder.Append('"')
    return $builder.ToString()
}

$nodeLock = $null
$scriptLock = $null
$lockfileLock = $null
$packageJsonLock = $null
$npmTreeLease = $null
$process = $null
$processJob = $null
$decodedArgumentBytes = $null
$standardOutput = ''
$standardError = ''
$expectedNpmTreeSha256ForLease = $null
$expectedLockfileSha256ForLease = $null
$expectedPackageJsonSha256ForLease = $null
$exitCode = 1
$completedSuccessfully = $false
try {
    if ([string]::IsNullOrWhiteSpace($EncodedScriptArguments) -or
        $EncodedScriptArguments.Length -gt 32760 -or
        $EncodedScriptArguments -cnotmatch '^[A-Za-z0-9_-]+$' -or
        ($EncodedScriptArguments.Length % 4) -eq 1) {
        Throw-HmaTrustedNodeFailure
    }
    $padding = '=' * ((4 - ($EncodedScriptArguments.Length % 4)) % 4)
    $decodedArgumentBytes = [Convert]::FromBase64String(
        $EncodedScriptArguments.Replace('-', '+').Replace('_', '/') + $padding
    )
    $canonicalArguments = [Convert]::ToBase64String(
        $decodedArgumentBytes
    ).TrimEnd('=').Replace('+', '-').Replace('/', '_')
    if (-not [string]::Equals(
            $canonicalArguments,
            $EncodedScriptArguments,
            [StringComparison]::Ordinal
        ) -or
        $decodedArgumentBytes.Length -gt 24576) {
        Throw-HmaTrustedNodeFailure
    }
    $strictUtf8 = New-Object Text.UTF8Encoding($false, $true)
    $argumentPayload = ConvertFrom-Json `
        -InputObject $strictUtf8.GetString($decodedArgumentBytes) `
        -ErrorAction Stop
    $argumentProperties = @(
        $argumentPayload.PSObject.Properties |
            ForEach-Object { $_.Name } |
            Sort-Object
    )
    if ([bool](Compare-Object `
            -ReferenceObject @('arguments', 'version') `
            -DifferenceObject $argumentProperties `
            -CaseSensitive) -or
        $argumentPayload.version -isnot [int] -or
        [int]$argumentPayload.version -ne 1 -or
        $argumentPayload.arguments -isnot [Array] -or
        @($argumentPayload.arguments).Count -gt 64) {
        Throw-HmaTrustedNodeFailure
    }
    $ScriptArguments = @($argumentPayload.arguments)
    if (@($ScriptArguments | Where-Object { $_ -isnot [string] }).Count -ne 0) {
        Throw-HmaTrustedNodeFailure
    }

    $trustedNode = Assert-HmaOrdinaryAbsoluteFile `
        -Candidate $NodePath `
        -ExpectedLeafName 'node.exe'
    $expectedNodePath = [IO.Path]::Combine(
        [IO.Path]::GetPathRoot([Environment]::SystemDirectory),
        'Program Files',
        'nodejs',
        'node.exe'
    )
    if (-not [string]::Equals(
            $trustedNode,
            $expectedNodePath,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        Throw-HmaTrustedNodeFailure
    }
    $scriptLeaf = [IO.Path]::GetFileName($ScriptPath)
    if ($scriptLeaf -cnotmatch '^[A-Za-z0-9][A-Za-z0-9._-]*\.mjs$') {
        Throw-HmaTrustedNodeFailure
    }
    $trustedScript = Assert-HmaOrdinaryAbsoluteFile `
        -Candidate $ScriptPath `
        -ExpectedLeafName $scriptLeaf
    $auditDirectory = [IO.Directory]::GetParent($trustedScript)
    $scriptsDirectory = if ($null -eq $auditDirectory) {
        $null
    } else {
        $auditDirectory.Parent
    }
    $projectDirectory = if ($null -eq $scriptsDirectory) {
        $null
    } else {
        $scriptsDirectory.Parent
    }
    if ($null -eq $auditDirectory -or
        $null -eq $scriptsDirectory -or
        $null -eq $projectDirectory -or
        -not [string]::Equals(
            $auditDirectory.Name,
            'audit',
            [StringComparison]::Ordinal
        ) -or
        -not [string]::Equals(
            $scriptsDirectory.Name,
            'scripts',
            [StringComparison]::Ordinal
        )) {
        Throw-HmaTrustedNodeFailure
    }
    $trustedProjectDirectory = Assert-HmaOrdinaryAbsoluteDirectory `
        -Candidate $projectDirectory.FullName
    $trustedNodeDirectory = Assert-HmaOrdinaryAbsoluteDirectory `
        -Candidate ([IO.Path]::GetDirectoryName($trustedNode))

    $nodeLock = [IO.File]::Open(
        $trustedNode,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    $scriptLock = [IO.File]::Open(
        $trustedScript,
        [IO.FileMode]::Open,
        [IO.FileAccess]::Read,
        [IO.FileShare]::Read
    )
    $sha256 = [Security.Cryptography.SHA256]::Create()
    try {
        $nodeHash = ([BitConverter]::ToString(
                $sha256.ComputeHash($nodeLock)
            )).Replace('-', '').ToLowerInvariant()
        $sha256.Initialize()
        $scriptHash = ([BitConverter]::ToString(
                $sha256.ComputeHash($scriptLock)
            )).Replace('-', '').ToLowerInvariant()
    } finally {
        $sha256.Dispose()
    }
    if (-not [string]::Equals(
            $nodeHash,
            $ExpectedNodeSha256,
            [StringComparison]::OrdinalIgnoreCase
        ) -or
        -not [string]::Equals(
            $scriptHash,
            $ExpectedScriptSha256,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        Throw-HmaTrustedNodeFailure
    }

    if ($scriptLeaf -ceq 'run-sanitized-validation.mjs') {
        $measureOnly = (
            $ScriptArguments.Count -eq 2 -and
            $ScriptArguments[0] -ceq '--measure-npm-tree'
        )
        $inventoryOnly = (
            $ScriptArguments.Count -eq 4 -and
            $ScriptArguments[0] -ceq '--inventory-install-scripts' -and
            $ScriptArguments[2] -ceq '--expected-lockfile-sha256' -and
            $ScriptArguments[3] -cmatch '^[a-fA-F0-9]{64}$'
        )
        $pinnedOperation = (
            $ScriptArguments.Count -eq 16 -and
            $ScriptArguments[0] -ceq '--run-pinned-npm' -and
            $ScriptArguments[1] -cin @('ci', 'ls', 'audit') -and
            $ScriptArguments[2] -ceq '--npm' -and
            $ScriptArguments[4] -ceq '--expected-npm-cli-sha256' -and
            $ScriptArguments[5] -cmatch '^[a-fA-F0-9]{64}$' -and
            $ScriptArguments[6] -ceq '--expected-npm-tree-sha256' -and
            $ScriptArguments[7] -cmatch '^[a-fA-F0-9]{64}$' -and
            $ScriptArguments[8] -ceq '--package-json' -and
            $ScriptArguments[10] -ceq '--expected-package-json-sha256' -and
            $ScriptArguments[11] -cmatch '^[a-fA-F0-9]{64}$' -and
            $ScriptArguments[12] -ceq '--package-lock' -and
            $ScriptArguments[14] -ceq '--expected-lockfile-sha256' -and
            $ScriptArguments[15] -cmatch '^[a-fA-F0-9]{64}$'
        )
        $validateAll = (
            $ScriptArguments.Count -eq 10 -and
            $ScriptArguments[0] -ceq '--npm' -and
            $ScriptArguments[2] -ceq '--expected-npm-cli-sha256' -and
            $ScriptArguments[3] -cmatch '^[a-fA-F0-9]{64}$' -and
            $ScriptArguments[4] -ceq '--expected-npm-tree-sha256' -and
            $ScriptArguments[5] -cmatch '^[a-fA-F0-9]{64}$' -and
            $ScriptArguments[6] -ceq '--package-json' -and
            $ScriptArguments[8] -ceq '--expected-package-json-sha256' -and
            $ScriptArguments[9] -cmatch '^[a-fA-F0-9]{64}$'
        )
        if (-not $measureOnly -and
            -not $inventoryOnly -and
            -not $pinnedOperation -and
            -not $validateAll) {
            Throw-HmaTrustedNodeFailure
        }
        if ($inventoryOnly) {
            $expectedLockfileSha256ForLease = $ScriptArguments[3]
            $trustedLockfile = Assert-HmaOrdinaryAbsoluteFile `
                -Candidate $ScriptArguments[1] `
                -ExpectedLeafName 'package-lock.json'
            if (-not [string]::Equals(
                    [IO.Path]::GetDirectoryName($trustedLockfile),
                    $trustedProjectDirectory,
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                Throw-HmaTrustedNodeFailure
            }
            $lockfileLock = [IO.File]::Open(
                $trustedLockfile,
                [IO.FileMode]::Open,
                [IO.FileAccess]::Read,
                [IO.FileShare]::Read
            )
            $lockfileSha256 = Get-HmaLockedStreamSha256 `
                -Stream $lockfileLock
            if (-not [string]::Equals(
                    $lockfileSha256,
                    $expectedLockfileSha256ForLease,
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                Throw-HmaTrustedNodeFailure
            }
        } else {
        $npmPathArgumentIndex = if ($pinnedOperation) { 3 } else { 1 }
        $trustedNpmPath = Assert-HmaOrdinaryAbsoluteFile `
            -Candidate $ScriptArguments[$npmPathArgumentIndex] `
            -ExpectedLeafName 'npm.cmd'
        if (-not [string]::Equals(
                [IO.Path]::GetDirectoryName($trustedNpmPath),
                $trustedNodeDirectory,
                [StringComparison]::OrdinalIgnoreCase
            )) {
            Throw-HmaTrustedNodeFailure
        }
        $trustedNpmRoot = Assert-HmaOrdinaryAbsoluteDirectory `
            -Candidate ([IO.Path]::Combine(
                    $trustedNodeDirectory,
                    'node_modules',
                    'npm'
                ))
        if ($validateAll -or $pinnedOperation) {
            $expectedNpmTreeSha256ForLease = if ($pinnedOperation) {
                $ScriptArguments[7]
            } else {
                $ScriptArguments[5]
            }
            $npmTreeLease = Enter-HmaNpmTreeLease `
                -NpmPath $trustedNpmPath `
                -NpmRoot $trustedNpmRoot `
                -ExpectedSha256 $expectedNpmTreeSha256ForLease
            if (-not (Assert-HmaProtectedNpmLeaseAcl `
                    -Lease $npmTreeLease `
                    -NodeDirectory $trustedNodeDirectory)) {
                Throw-HmaTrustedNodeFailure
            }
        }

        if ($validateAll -or $pinnedOperation) {
            $packageJsonPathIndex = if ($pinnedOperation) { 9 } else { 7 }
            $packageJsonHashIndex = if ($pinnedOperation) { 11 } else { 9 }
            $expectedPackageJsonSha256ForLease = (
                $ScriptArguments[$packageJsonHashIndex]
            )
            $trustedPackageJson = Assert-HmaOrdinaryAbsoluteFile `
                -Candidate $ScriptArguments[$packageJsonPathIndex] `
                -ExpectedLeafName 'package.json'
            if (-not [string]::Equals(
                    [IO.Path]::GetDirectoryName($trustedPackageJson),
                    $trustedProjectDirectory,
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                Throw-HmaTrustedNodeFailure
            }
            $packageJsonLock = [IO.File]::Open(
                $trustedPackageJson,
                [IO.FileMode]::Open,
                [IO.FileAccess]::Read,
                [IO.FileShare]::Read
            )
            if (-not [string]::Equals(
                    (Get-HmaLockedStreamSha256 -Stream $packageJsonLock),
                    $expectedPackageJsonSha256ForLease,
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                Throw-HmaTrustedNodeFailure
            }
        }

        if ($pinnedOperation) {
            $expectedLockfileSha256ForLease = $ScriptArguments[15]
            $trustedLockfile = Assert-HmaOrdinaryAbsoluteFile `
                -Candidate $ScriptArguments[13] `
                -ExpectedLeafName 'package-lock.json'
            if (-not [string]::Equals(
                    [IO.Path]::GetDirectoryName($trustedLockfile),
                    $trustedProjectDirectory,
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                Throw-HmaTrustedNodeFailure
            }
            $lockfileLock = [IO.File]::Open(
                $trustedLockfile,
                [IO.FileMode]::Open,
                [IO.FileAccess]::Read,
                [IO.FileShare]::Read
            )
            if (-not [string]::Equals(
                    (Get-HmaLockedStreamSha256 -Stream $lockfileLock),
                    $expectedLockfileSha256ForLease,
                    [StringComparison]::OrdinalIgnoreCase
                )) {
                Throw-HmaTrustedNodeFailure
            }
        }
        }
    }

    $systemDirectory = Assert-HmaOrdinaryAbsoluteDirectory `
        -Candidate ([Environment]::SystemDirectory)
    $systemRoot = Assert-HmaOrdinaryAbsoluteDirectory `
        -Candidate ([IO.Directory]::GetParent($systemDirectory).FullName)
    $commandProcessor = Assert-HmaOrdinaryAbsoluteFile `
        -Candidate ([IO.Path]::Combine($systemDirectory, 'cmd.exe')) `
        -ExpectedLeafName 'cmd.exe'
    $trustedTemporaryDirectory = Assert-HmaOrdinaryAbsoluteDirectory `
        -Candidate ([Environment]::GetEnvironmentVariable('TEMP', 'Process'))

    $reviewedArguments = New-Object 'Collections.Generic.List[string]'
    $totalArgumentLength = $trustedScript.Length + 3
    foreach ($argument in @($ScriptArguments)) {
        $reviewedArgument = Assert-HmaSafeScriptArgument -Value $argument
        $totalArgumentLength += $reviewedArgument.Length + 3
        if ($totalArgumentLength -gt 24000) {
            Throw-HmaTrustedNodeFailure
        }
        [void]$reviewedArguments.Add($reviewedArgument)
    }

    $commandLineArguments = New-Object 'Collections.Generic.List[string]'
    [void]$commandLineArguments.Add('--')
    [void]$commandLineArguments.Add(
        (ConvertTo-HmaWindowsCommandLineArgument -Value $trustedScript)
    )
    foreach ($argument in $reviewedArguments) {
        [void]$commandLineArguments.Add(
            (ConvertTo-HmaWindowsCommandLineArgument -Value $argument)
        )
    }

    $nativeCommandLine = (
        (ConvertTo-HmaWindowsCommandLineArgument -Value $trustedNode) +
        ' ' +
        [string]::Join(' ', $commandLineArguments)
    )
    $reviewedEnvironment = [string[]]@(
        ('ComSpec=' + $commandProcessor),
        ('PATH=' + $trustedNodeDirectory),
        'PATHEXT=.COM;.EXE',
        ('SystemRoot=' + $systemRoot),
        ('TEMP=' + $trustedTemporaryDirectory),
        ('TMP=' + $trustedTemporaryDirectory),
        ('WINDIR=' + $systemRoot)
    )

    Initialize-HmaTrustedProcessJobType
    $processJob = [Hma.TrustedProcessJob]::CreateKillOnClose()
    $process = [Hma.TrustedProcessJob]::StartSuspendedAssigned(
        $trustedNode,
        $nativeCommandLine,
        $trustedProjectDirectory,
        $reviewedEnvironment,
        $processJob
    )
    $standardOutputTask = $process.ReadStandardOutputToEndAsync()
    $standardErrorTask = $process.ReadStandardErrorToEndAsync()
    $process.WaitForExit()
    $exitCode = [int]$process.ExitCode
    Stop-HmaTrustedProcessTree `
        -JobHandle $processJob `
        -Process $process
    $processJob = $null
    $standardOutput = $standardOutputTask.GetAwaiter().GetResult()
    $standardError = $standardErrorTask.GetAwaiter().GetResult()

    if ($null -ne $lockfileLock) {
        $lockfileSha256 = Get-HmaLockedStreamSha256 `
            -Stream $lockfileLock
        if (-not [string]::Equals(
                $lockfileSha256,
                $expectedLockfileSha256ForLease,
                [StringComparison]::OrdinalIgnoreCase
            )) {
            Throw-HmaTrustedNodeFailure
        }
    }
    if ($null -ne $packageJsonLock -and
        -not [string]::Equals(
            (Get-HmaLockedStreamSha256 -Stream $packageJsonLock),
            $expectedPackageJsonSha256ForLease,
            [StringComparison]::OrdinalIgnoreCase
        )) {
        Throw-HmaTrustedNodeFailure
    }
    if ($null -ne $npmTreeLease -and
        (
            -not (Assert-HmaProtectedNpmLeaseAcl `
                    -Lease $npmTreeLease `
                    -NodeDirectory $trustedNodeDirectory) -or
            -not (Assert-HmaNpmTreeLease `
                    -Lease $npmTreeLease `
                    -ExpectedSha256 $expectedNpmTreeSha256ForLease)
        )) {
            Throw-HmaTrustedNodeFailure
    }
    if ($exitCode -eq 0) {
        if (-not $PassThruResult) {
            [Console]::Out.Write($standardOutput)
            [Console]::Error.Write($standardError)
        }
        $completedSuccessfully = $true
    }
} catch {
    $exitCode = 1
} finally {
    if ($null -ne $processJob) {
        Stop-HmaTrustedProcessTree `
            -JobHandle $processJob `
            -Process $process
        $processJob = $null
    }
    if ($null -ne $process) {
        $process.Dispose()
    }
    if ($null -ne $scriptLock) {
        $scriptLock.Dispose()
    }
    if ($null -ne $lockfileLock) {
        $lockfileLock.Dispose()
    }
    if ($null -ne $packageJsonLock) {
        $packageJsonLock.Dispose()
    }
    if ($null -ne $npmTreeLease) {
        Exit-HmaNpmTreeLease -Lease $npmTreeLease
    }
    if ($null -ne $nodeLock) {
        $nodeLock.Dispose()
    }
    if ($null -ne $decodedArgumentBytes) {
        [Array]::Clear(
            $decodedArgumentBytes,
            0,
            $decodedArgumentBytes.Length
        )
    }
}

if ($PassThruResult) {
    [pscustomobject][ordered]@{
        version = 1
        ok = [bool]$completedSuccessfully
        exitCode = [int]$exitCode
        stdout = if ($completedSuccessfully) {
            [string]$standardOutput
        } else {
            ''
        }
        stderr = if ($completedSuccessfully) {
            [string]$standardError
        } else {
            ''
        }
    }
    return
}
if (-not $completedSuccessfully) {
    [Console]::Error.WriteLine('Trusted Node launch failed.')
}
[Environment]::Exit($exitCode)

# OkHttp ships its own consumer rules; keep our classes readable in crash logs.
-keepattributes SourceFile,LineNumberTable
-dontwarn org.conscrypt.**
-dontwarn org.bouncycastle.**
-dontwarn org.openjsse.**

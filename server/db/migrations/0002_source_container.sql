-- T089：记录原始媒体容器格式，供媒体响应输出准确 MIME（此前凭 video codec 猜测可能出错）。
ALTER TABLE source_media ADD COLUMN container TEXT;

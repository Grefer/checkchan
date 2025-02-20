const fs = require("fs");
const dayjs = require("dayjs");
const { monitor_auto, send_notify, get_data_dir, cron_check, logstart, logit, to_markdown } = require("./func");

const data_file = get_data_dir() + 'data.json';
const content = fs.readFileSync( data_file );
const json_data = JSON.parse( content );

const to_checks = json_data.checks.filter( item => parseInt(item.enabled) === 1 && parseInt(item.is_cloud_task||0) >= 1 );

run = async () =>{
logstart();
logit("开始载入任务");
for( const item of to_checks )
{
    let do_now = false;
    if( parseInt( item.interval ) < 0 ) item.interval = 0;

    // 判断是否应该监测
    if( item.last_time )
    {
        if( item.interval > 0 )
        {
            if(dayjs(item.last_time).add(item.interval,'minutes').isBefore(dayjs())) do_now = true; 
        }

        if( item.interval == 0 )
        {
            do_now = true; 
        }
    }else
    {
        do_now = true; 
    }

    // 处理cron逻辑
    if( item.cron && !cron_check(item.cron) )
    {
        do_now = false;
        console.log("监测时间监测，跳过"+item.cron);
    }
    
    // 处理retry
    if( parseInt(item.retry) < 1 ) item.retry = 10;
    if( parseInt(item.retry_times) > parseInt(item.retry) )
    {
        do_now = false; 
        logit("重试次数超过，跳过"+item.title);
    }
    logit( item.title + "...条件检查 " +do_now );
    if( do_now )
    {
        // 返回状态，默认为成功
        // 0:未检测，1:成功但没有变动，2：成功且有异动
        let check_status = 0; 
        let check_content = ""; 
        let check_html = ""; 
        
        logit("checking..."+item.title, dayjs().format('YYYY-MM-DD HH:mm:ss'));
        
        const ret = await monitor_auto( item, json_data.cookies );
        if( ret && ret.status )
        {
            check_content = ret.value;
            if( ret.html ) check_html = ret.html;
            check_status = 1;
            
        }
        else
            check_status = -1;

        const {html, ...ret_short} = ret;
        logit( ret_short );

        if( check_status < 0 )
        {
            // 失败
            // 重试流程
            const retry_times = parseInt( item.retry_times||0 );
            if( retry_times >= item.retry )
            {
                // 发送通知
                await send_notify( '监测点['+item.title+']多次重试失败', "已暂停执行，请检查登录状态或页面结构变动\r\n\r\n[点此查看]("+item.url+")" , item.sendkey);
            }
            check_update_field( item.id, 'retry_times', retry_times+1, json_data );
            
        }else
        {
            // 成功分支
            const last_content = item.last_content;
            
            // 先更新再发通知，避免发送操作中断
            check_update_field( item.id, 'last_content', check_content, json_data );
            check_update_field( item.id, 'last_time', Date.now(), json_data );
            
            // 重试计数清理
            check_update_field( item.id, 'retry_times', 0, json_data);
            
            let can_send_notice = true;

            if( item.when == 'change' )
            {
                logit("变动时发送");
                if( !last_content || (check_content?.trim() == last_content?.trim()) )
                {
                    logit("内容相同或者旧内容不存在，跳过");
                    can_send_notice = false;
                }
            }

            if( item.compare_type == 'regex' )
            {
                logit("正则匹配模式");
                if( item.regex && !check_content.match( new RegExp(item.regex, 'i') ) )
                {
                    can_send_notice = false;
                    logit( '通知正则不匹配，不发送通知' );
                }
            }
            
            if( item.compare_type == 'op' )
            {
                logit("条件比较模式");
                
                let the_value = item.compare_value;
                            
                if( item.compare_value == '*请求返回状态码*' ) the_value = item.code;
                
                if( item.compare_value == '*上次监测返回值*' ) the_value = last_content;
                

                if( item.compare_op == 'ne' && !(check_content != the_value)) can_send_notice = false;

                if( item.compare_op == 'eq' && !(check_content == the_value)) can_send_notice = false;

                if( item.compare_op == 'gt' && !(parseFloat(check_content) > parseFloat(the_value||0))) can_send_notice = false;

                if( item.compare_op == 'gte' && !(parseFloat(check_content) >= parseFloat(the_value||0))) can_send_notice = false;

                if( item.compare_op == 'lt' && !(parseFloat(check_content) < parseFloat(the_value||0))) can_send_notice = false;

                if( item.compare_op == 'lte' && !(parseFloat(check_content) <= parseFloat(the_value||0))) can_send_notice = false;

                // console.log("op:",check_content,item.compare_op,the_value,can_send_notice);

                logit("op:"+parseFloat(check_content)+' '+item.compare_op+' '+parseFloat(the_value||0)+' '+can_send_notice);

            } 
                
              
            
            if( can_send_notice )
            {
                logit( '已发送通知' );
            
                if( item.sendkey )
                {
                    const title = '监测点['+item.title+']有新通知';
                                
                    let desp = check_content?.substring(0,50) + (item.last_content ? ('←' + item.last_content.substring(0,50)):"");
                    
                    if( check_html )
                        desp += "\r\n\r\n" + to_markdown(check_html); 
                    
                    // const title = check_content.length > 50 ? '监测点['+item.title+']有新通知' : ( '监测点['+item.title+']有新通知: ' + check_content + (item.last_content ? ('←' + item.last_content):"") );

                    // const desp = check_content.length > 50 ? (check_html ? to_markdown(check_html) : check_content) :  check_content + (item.last_content ? ('←' + item.last_content):"") ;
                    
                    
                    await send_notify( title, desp , item.sendkey);  
                }
            }
        } 
    }
}

logit("全部任务处理完成");

} 

run();



async function check_update_field( id, field, value, json_data )
{
    const the_idx = json_data.checks.findIndex(item => item.id == id);
    if( the_idx < 0 ) return false;
    json_data.checks[the_idx][field] = value;
    fs.writeFileSync( data_file, JSON.stringify(json_data) );
}